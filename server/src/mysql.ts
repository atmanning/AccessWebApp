/**
 * External MySQL / MariaDB connections: saved per database (credentials encrypted at rest),
 * tested, browsed as linked tables, queried from a SQL console, and imported as local tables.
 */
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import mysql, { type FieldPacket, type ResultSetHeader } from "mysql2/promise";
import type { CellValue, ConnectionInput, Field, RemoteForeignKey, RemoteRows, RemoteTableInfo, SqlRunResult, SslMode } from "../../shared/model.js";
import type { ExchangeColumn, ExchangeDocument } from "../../shared/exchange.js";

// ---- Secrets ------------------------------------------------------------------------------

/**
 * Encrypts saved passwords with AES-256-GCM. The key comes from CONNECTION_SECRET, or is
 * generated once into DATA_DIR/connection.key (kept on the same persistent disk as the data).
 */
export function createSecretBox(dataDir: string, envSecret?: string) {
  let key: Buffer;
  if (envSecret) key = crypto.createHash("sha256").update(envSecret).digest();
  else {
    const file = path.join(dataDir, "connection.key");
    if (fs.existsSync(file)) key = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    else {
      fs.mkdirSync(dataDir, { recursive: true });
      key = crypto.randomBytes(32);
      fs.writeFileSync(file, key.toString("base64"), { mode: 0o600 });
    }
  }
  return {
    encrypt(plain: string): string {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
    },
    decrypt(stored: string): string {
      const [v, iv, tag, enc] = stored.split(":");
      if (v !== "v1") throw new Error("Unknown password format");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(enc, "base64")), decipher.final()]).toString("utf8");
    },
  };
}
export type SecretBox = ReturnType<typeof createSecretBox>;

// ---- Network guard --------------------------------------------------------------------------

/** Loopback, private, link-local (incl. cloud metadata), CGNAT and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("ff");
}

/**
 * Resolves the host once and returns the address to connect to, refusing private networks
 * unless allowed. Connecting to the resolved address (not the name) prevents DNS rebinding.
 */
export async function resolveHost(host: string, allowPrivate: boolean): Promise<string> {
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new MySqlError(2005, "HY000", `Unknown MySQL server host '${host}'`);
  if (!allowPrivate && addresses.some(isPrivateAddress)) {
    throw new MySqlError(
      2003,
      "HY000",
      `Can't connect to '${host}': private and internal network addresses are blocked on this server. Use the database's public address.`,
    );
  }
  return addresses[0];
}

// ---- Errors, shaped like the mysql client's -------------------------------------------------

export class MySqlError extends Error {
  constructor(public errno: number | null, public sqlState: string | null, message: string, public code: string | null = null) {
    super(message);
  }
}

/** Turns driver and socket errors into mysql-client style messages (ERROR 2003 (HY000): ...). */
export function toMySqlError(e: unknown, cfg?: { host: string; port: number }): MySqlError {
  if (e instanceof MySqlError) return e;
  const err = e as { errno?: number; sqlState?: string; sqlMessage?: string; code?: string; message?: string };
  if (err.sqlMessage) return new MySqlError(err.errno ?? null, err.sqlState ?? null, err.sqlMessage, err.code ?? null);
  const where = cfg ? `'${cfg.host}:${cfg.port}'` : "the server";
  switch (err.code) {
    case "ECONNREFUSED":
      return new MySqlError(2003, "HY000", `Can't connect to MySQL server on ${where} (111 "Connection refused")`, err.code);
    case "ETIMEDOUT":
    case "ECONNRESET":
      return new MySqlError(2003, "HY000", `Can't connect to MySQL server on ${where} (110 "Connection timed out")`, err.code);
    case "ENOTFOUND":
      return new MySqlError(2005, "HY000", `Unknown MySQL server host ${where}`, err.code);
    case "HANDSHAKE_NO_SSL_SUPPORT":
      return new MySqlError(2026, "HY000", "SSL connection error: the server doesn't support SSL. Set SSL to Off.", err.code);
    case "PROTOCOL_SEQUENCE_TIMEOUT":
      return new MySqlError(3024, "HY000", "Query execution was interrupted: it took longer than 30 seconds.", err.code);
    default:
      return new MySqlError(err.errno && err.errno > 0 ? err.errno : null, err.sqlState ?? "HY000", err.message ?? String(e), err.code ?? null);
  }
}

// ---- Connecting -------------------------------------------------------------------------------

export interface ConnectionSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: SslMode;
}

const QUERY_TIMEOUT_MS = 30_000;

export async function connect(cfg: ConnectionSettings, allowPrivate: boolean) {
  const address = await resolveHost(cfg.host, allowPrivate);
  try {
    return await mysql.createConnection({
      // Connect to the checked address. Certificate verification needs the host name instead
      // (the driver checks the certificate against it); the name was just checked above.
      host: cfg.ssl === "verify" ? cfg.host : address,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database || undefined,
      connectTimeout: 10_000,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      multipleStatements: false,
      charset: "utf8mb4",
      ssl: cfg.ssl === "off" ? undefined : { rejectUnauthorized: cfg.ssl === "verify" },
    });
  } catch (e) {
    throw toMySqlError(e, cfg);
  }
}

type Conn = Awaited<ReturnType<typeof connect>>;

export async function withConnection<T>(cfg: ConnectionSettings, allowPrivate: boolean, fn: (c: Conn) => Promise<T>): Promise<T> {
  const c = await connect(cfg, allowPrivate);
  try {
    return await fn(c);
  } catch (e) {
    throw toMySqlError(e, cfg);
  } finally {
    c.end().catch(() => c.destroy());
  }
}

export async function testConnection(cfg: ConnectionSettings, allowPrivate: boolean) {
  const started = Date.now();
  return withConnection(cfg, allowPrivate, async (c) => {
    const [rows] = await c.query({ sql: "SELECT VERSION() AS v, DATABASE() AS db", timeout: QUERY_TIMEOUT_MS });
    const r = (rows as { v: string; db: string | null }[])[0];
    // The databases this user can see, to pick from when none is set.
    const [dbs] = await c.query({ sql: "SHOW DATABASES", timeout: QUERY_TIMEOUT_MS, rowsAsArray: true });
    const system = new Set(["information_schema", "mysql", "performance_schema", "sys"]);
    const databases = (dbs as unknown[][]).map((d) => String(d[0])).filter((d) => !system.has(d.toLowerCase()));
    return { version: r.v, database: r.db, databases, ms: Date.now() - started };
  });
}

// ---- Types: MySQL -> Access -------------------------------------------------------------------

interface ColumnInfo {
  COLUMN_NAME: string;
  DATA_TYPE: string;
  COLUMN_TYPE: string;
  CHARACTER_MAXIMUM_LENGTH: number | null;
  NUMERIC_SCALE: number | null;
  IS_NULLABLE: "YES" | "NO";
  COLUMN_KEY: string;
  COLUMN_DEFAULT: string | null;
  EXTRA: string;
  COLUMN_COMMENT: string;
}

/** Maps a column from INFORMATION_SCHEMA to an Access field type; null when unsupported (binary data). */
export function mapColumn(c: ColumnInfo): Omit<ExchangeColumn, "name"> | null {
  const t = c.DATA_TYPE.toLowerCase();
  const unsigned = /unsigned/i.test(c.COLUMN_TYPE);
  const auto = /auto_increment/i.test(c.EXTRA);
  if (t === "tinyint" && /^tinyint\(1\)/i.test(c.COLUMN_TYPE)) return { type: "YesNo" };
  if (t === "bit") return /^bit\(1\)$/i.test(c.COLUMN_TYPE) ? { type: "YesNo" } : { type: "Number", numberSize: "Double" };
  if (t === "bool" || t === "boolean") return { type: "YesNo" };
  if (["tinyint", "smallint", "mediumint", "int", "integer", "bigint"].includes(t)) {
    if (auto && t !== "bigint" && !(t === "int" && unsigned)) return { type: "AutoNumber" };
    if (t === "tinyint") return { type: "Number", numberSize: unsigned ? "Byte" : "Integer" };
    if (t === "smallint") return { type: "Number", numberSize: unsigned ? "Long" : "Integer" };
    if (t === "mediumint" || (t === "int" && !unsigned) || t === "integer") return { type: "Number", numberSize: "Long" };
    return { type: "Number", numberSize: "Double" }; // unsigned int, bigint
  }
  if (t === "decimal" || t === "numeric") return (c.NUMERIC_SCALE ?? 0) <= 4 ? { type: "Currency" } : { type: "Number", numberSize: "Double" };
  if (t === "float") return { type: "Number", numberSize: "Single" };
  if (t === "double" || t === "real") return { type: "Number", numberSize: "Double" };
  if (t === "date" || t === "datetime" || t === "timestamp") return { type: "DateTime" };
  if (t === "year") return { type: "Number", numberSize: "Integer" };
  if (t === "time") return { type: "ShortText", size: 16 };
  if (t === "char" || t === "varchar") {
    const n = c.CHARACTER_MAXIMUM_LENGTH ?? 255;
    return n <= 255 ? { type: "ShortText", size: Math.max(1, n) } : { type: "LongText" };
  }
  if (t === "enum" || t === "set") return { type: "ShortText", size: 255 };
  if (t.endsWith("text") || t === "json") return { type: "LongText" };
  return null; // blob, binary, varbinary, geometry...
}

/** Field types for console results, from the driver's column metadata. */
function fieldFromPacket(f: FieldPacket): Field | null {
  const base = { id: f.name, name: f.name.slice(0, 64) || "Expr" } as Field;
  const binary = f.characterSet === 63;
  switch (f.columnType) {
    case 1: // TINY
      return { ...base, type: (f.columnLength ?? 4) === 1 ? "YesNo" : "Number", numberSize: "Integer" };
    case 2: case 3: case 9: case 13: // SHORT, LONG, INT24, YEAR
      return { ...base, type: "Number", numberSize: "Long" };
    case 8: case 4: case 5: // LONGLONG, FLOAT, DOUBLE
      return { ...base, type: "Number", numberSize: "Double" };
    case 0: case 246: // DECIMAL
      return { ...base, type: (f.decimals ?? 0) <= 4 ? "Currency" : "Number", numberSize: "Double" };
    case 7: case 10: case 12: case 14: // TIMESTAMP, DATE, DATETIME, NEWDATE
      return { ...base, type: "DateTime" };
    case 16:
      return { ...base, type: "YesNo" };
    case 245:
      return { ...base, type: "LongText" };
    case 249: case 250: case 251: case 252: case 253: case 254: case 15:
      return binary ? null : { ...base, type: "ShortText" };
    default:
      return { ...base, type: "ShortText" };
  }
}

/** Converts a driver value into what the Access-style grid stores. */
export function toCell(type: Field["type"] | undefined, v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) {
    if (type === "YesNo") return v.length > 0 && v[0] !== 0;
    return `(binary, ${v.length} bytes)`;
  }
  if (type === "YesNo") return v === 1 || v === true || v === "1";
  if (type === "DateTime" && typeof v === "string") {
    if (v.startsWith("0000-00-00")) return null;
    const m = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2})(:\d{2})?)?/.exec(v);
    if (!m) return v;
    if (!m[2] || (m[2] === "00:00" && (!m[3] || m[3] === ":00"))) return m[1];
    return `${m[1]}T${m[2]}${m[3] && m[3] !== ":00" ? m[3] : ""}`;
  }
  if ((type === "Number" || type === "Currency" || type === "AutoNumber") && typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
  return JSON.stringify(v);
}

// ---- Operations -------------------------------------------------------------------------------

const qi = (name: string) => "`" + name.replace(/`/g, "``") + "`";

export async function listTables(c: Conn): Promise<RemoteTableInfo[]> {
  const [rows] = await c.query({
    sql: `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS n FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`,
    timeout: QUERY_TIMEOUT_MS,
  });
  return (rows as { name: string; type: string; n: number | null }[]).map((r) => ({
    name: r.name,
    type: /view/i.test(r.type) ? "view" : "table",
    rows: r.n === null ? null : Number(r.n),
  }));
}

async function columnsOf(c: Conn, table: string): Promise<ColumnInfo[]> {
  const [rows] = await c.query({
    sql: `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_SCALE, IS_NULLABLE, COLUMN_KEY,
                 COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT
          FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    values: [table],
    timeout: QUERY_TIMEOUT_MS,
  });
  const cols = rows as ColumnInfo[];
  if (!cols.length) throw new MySqlError(1146, "42S02", `Table '${table}' doesn't exist in this database`);
  return cols;
}

/** One page of a linked table's rows. */
export async function browseTable(c: Conn, table: string, offset: number, limit: number): Promise<RemoteRows> {
  const cols = await columnsOf(c, table);
  const kept = cols.map((col) => ({ col, map: mapColumn(col) })).filter((x) => x.map);
  const skipped = cols.filter((col) => !mapColumn(col)).map((col) => col.COLUMN_NAME);
  const fields = kept.map(({ col, map }) => ({ id: col.COLUMN_NAME, name: col.COLUMN_NAME.slice(0, 64), ...map, description: col.COLUMN_COMMENT || undefined }) as Field);
  const select = kept.length ? kept.map((k) => qi(k.col.COLUMN_NAME)).join(", ") : "1";
  const [rows] = await c.query({ sql: `SELECT ${select} FROM ${qi(table)} LIMIT ? OFFSET ?`, values: [limit, offset], rowsAsArray: true, timeout: QUERY_TIMEOUT_MS });
  let total: number | null = null;
  try {
    const [count] = await c.query({ sql: `SELECT COUNT(*) AS n FROM ${qi(table)}`, timeout: 10_000 });
    total = Number((count as { n: number }[])[0].n);
  } catch {
    /* very large tables: leave the total unknown */
  }
  return {
    columns: fields.map((f) => f.name),
    fields,
    rows: (rows as unknown[][]).map((r) => (kept.length ? r.map((v, i) => toCell(fields[i].type, v)) : [])),
    total,
    offset,
    skipped,
  };
}

/** Runs one statement, returning rows or an OK packet like the mysql client prints. */
export async function runSql(c: Conn, sql: string, maxRows: number): Promise<SqlRunResult> {
  const started = Date.now();
  try {
    const [result, packets] = await c.query({ sql, rowsAsArray: true, timeout: QUERY_TIMEOUT_MS });
    const elapsedMs = Date.now() - started;
    // CALL returns several result sets; show the first one with rows.
    const sets = Array.isArray(result) && Array.isArray(result[0]) && Array.isArray(packets?.[0]) ? (result as unknown[][][]) : null;
    const rows = sets ? sets[0] : result;
    const fieldPackets = (sets ? (packets as unknown as FieldPacket[][])[0] : packets) as FieldPacket[] | undefined;
    if (Array.isArray(rows) && fieldPackets) {
      const fields = fieldPackets.map(fieldFromPacket);
      const all = rows as unknown[][];
      return {
        kind: "rows",
        columns: fieldPackets.map((f) => f.name),
        fields,
        rows: all.slice(0, maxRows).map((r) => r.map((v, i) => toCell(fields[i]?.type, v))),
        truncated: all.length > maxRows,
        elapsedMs,
      };
    }
    const ok = result as ResultSetHeader;
    return {
      kind: "ok",
      affectedRows: ok.affectedRows ?? 0,
      changedRows: (ok as { changedRows?: number }).changedRows,
      insertId: ok.insertId || undefined,
      info: ok.info ?? "",
      warnings: ok.warningStatus ?? 0,
      elapsedMs,
    };
  } catch (e) {
    const err = toMySqlError(e);
    return { kind: "error", errno: err.errno, sqlState: err.sqlState, code: err.code, message: err.message, elapsedMs: Date.now() - started };
  }
}

/** Reads whole tables (structure, data, keys, indexes, foreign keys) in the exchange format. */
export async function readTablesForImport(c: Conn, tables: string[], maxRows: number): Promise<ExchangeDocument> {
  const warnings: string[] = [];
  const out: ExchangeDocument = { tables: [], relationships: [], queries: [], warnings };
  let budget = maxRows;
  for (const table of tables) {
    const cols = await columnsOf(c, table);
    const [idx] = await c.query({
      sql: `SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      values: [table],
      timeout: QUERY_TIMEOUT_MS,
    });
    const indexes = new Map<string, { cols: string[]; unique: boolean }>();
    for (const r of idx as { INDEX_NAME: string; COLUMN_NAME: string; NON_UNIQUE: number }[]) {
      const e = indexes.get(r.INDEX_NAME) ?? { cols: [], unique: Number(r.NON_UNIQUE) === 0 };
      e.cols.push(r.COLUMN_NAME);
      indexes.set(r.INDEX_NAME, e);
    }
    const pk = new Set(indexes.get("PRIMARY")?.cols ?? []);
    const columns: (ExchangeColumn & { source: string })[] = [];
    for (const col of cols) {
      const map = mapColumn(col);
      if (!map) {
        warnings.push(`Skipped field '${table}.${col.COLUMN_NAME}' (${col.COLUMN_TYPE} data can't be stored here).`);
        continue;
      }
      let indexed: string | undefined;
      for (const [name, ix] of indexes) {
        if (name === "PRIMARY" || ix.cols.length !== 1 || ix.cols[0] !== col.COLUMN_NAME) continue;
        indexed = ix.unique ? "YesNoDup" : indexed ?? "YesDup";
      }
      if (map.type === "Number" && map.numberSize === "Double" && /bigint/i.test(col.DATA_TYPE)) {
        warnings.push(`'${table}.${col.COLUMN_NAME}' is a BIGINT; values above 9,007,199,254,740,991 lose precision.`);
      }
      const def = col.COLUMN_DEFAULT;
      columns.push({
        source: col.COLUMN_NAME,
        name: col.COLUMN_NAME,
        ...map,
        primaryKey: pk.has(col.COLUMN_NAME) || undefined,
        required: col.IS_NULLABLE === "NO" && !pk.has(col.COLUMN_NAME) && map.type !== "AutoNumber" && def === null ? true : undefined,
        indexed,
        description: col.COLUMN_COMMENT || undefined,
        // Only plain literal defaults carry over (not CURRENT_TIMESTAMP and other expressions).
        defaultValue: def !== null && /^'.*'$|^-?\d+(\.\d+)?$/.test(def) ? def.replace(/^'(.*)'$/, '"$1"') : undefined,
      });
    }
    if (!columns.length) {
      warnings.push(`Skipped table '${table}': none of its fields can be stored here.`);
      continue;
    }
    const limit = Math.max(0, budget);
    const [rows] = await c.query({
      sql: `SELECT ${columns.map((k) => qi(k.source)).join(", ")} FROM ${qi(table)} LIMIT ?`,
      values: [limit],
      rowsAsArray: true,
      timeout: 120_000,
    });
    const data = rows as unknown[][];
    budget -= data.length;
    const [count] = await c.query({ sql: `SELECT COUNT(*) AS n FROM ${qi(table)}`, timeout: QUERY_TIMEOUT_MS });
    const total = Number((count as { n: number }[])[0].n);
    if (data.length < total) warnings.push(`Only the first ${data.length} of ${total} records in '${table}' were imported (limit ${maxRows} in total).`);
    out.tables.push({
      name: table,
      columns: columns.map(({ source: _s, ...rest }) => rest),
      rows: data.map((r) => r.map((v, i) => toCell(columns[i].type as Field["type"], v))),
    });
  }
  // Foreign keys between the imported tables become relationships.
  const names = new Set(out.tables.map((t) => t.name));
  for (const fk of await listForeignKeys(c)) {
    if (!names.has(fk.table) || !names.has(fk.refTable)) continue;
    if (fk.columns.length > 1) {
      warnings.push(`Skipped foreign key '${fk.name}' (multi-field relationships aren't supported yet).`);
      continue;
    }
    const [col] = fk.columns;
    out.relationships.push({ fromTable: fk.refTable, fromColumn: col.refField, toTable: fk.table, toColumn: col.field, enforce: true });
  }
  return out;
}

/** The database's foreign keys, one entry per constraint with its columns in order. */
export async function listForeignKeys(c: Conn): Promise<RemoteForeignKey[]> {
  const [rows] = await c.query({
    sql: `SELECT k.CONSTRAINT_NAME AS name, k.TABLE_NAME AS child, k.COLUMN_NAME AS childCol,
                 k.REFERENCED_TABLE_NAME AS parent, k.REFERENCED_COLUMN_NAME AS parentCol
          FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
          WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
            AND (k.REFERENCED_TABLE_SCHEMA IS NULL OR k.REFERENCED_TABLE_SCHEMA = DATABASE())
          ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    timeout: QUERY_TIMEOUT_MS,
  });
  const byKey = new Map<string, RemoteForeignKey>();
  for (const r of rows as { name: string; child: string; childCol: string; parent: string; parentCol: string }[]) {
    const key = `${r.child}\u0000${r.name}`;
    let fk = byKey.get(key);
    if (!fk) byKey.set(key, (fk = { name: r.name, table: r.child, refTable: r.parent, columns: [] }));
    fk.columns.push({ field: r.childCol, refField: r.parentCol });
  }
  return [...byKey.values()];
}

export function settingsFrom(input: ConnectionInput, password: string): ConnectionSettings {
  return { host: input.host, port: input.port, database: input.database, user: input.user, password, ssl: input.ssl };
}
