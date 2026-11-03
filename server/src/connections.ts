/**
 * /api/projects/:id/connections — saved MySQL connections for a database.
 * Editors and owners manage connections, run SQL and import; viewers can list and browse
 * linked tables. Passwords are never returned.
 */
import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import type { DB } from "./db.js";
import { requireUser } from "./auth.js";
import { httpError, projectLoader } from "./projects.js";
import {
  connectionInputSchema,
  type ConnectionInfo,
  type ConnectionInput,
  type SslMode,
} from "../../shared/model.js";
import { fromExchangeDocument } from "../../shared/exchange.js";
import {
  browseTable,
  listForeignKeys,
  listTables,
  MySqlError,
  readTablesForImport,
  runSql,
  settingsFrom,
  testConnection,
  toMySqlError,
  withConnection,
  type ConnectionSettings,
  type SecretBox,
} from "./mysql.js";

interface ConnectionRow {
  id: string;
  project_id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password_enc: string;
  ssl: SslMode;
}

export interface ConnectionsOptions {
  secrets: SecretBox;
  /** Allow connecting to private/loopback addresses (self-hosting); off on public servers. */
  allowPrivateHosts: boolean;
}

const MAX_CONNECTIONS = 50;
const MAX_CONSOLE_ROWS = 5_000;
const MAX_IMPORT_ROWS = 200_000;
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

const info = (r: ConnectionRow): ConnectionInfo => ({
  id: r.id,
  name: r.name,
  host: r.host,
  port: r.port,
  database: r.database,
  user: r.username,
  ssl: r.ssl,
  hasPassword: r.password_enc !== "",
});

/**
 * Accepts mysql://user:pass@host:port/db pasted into the server box, as many hosting dashboards
 * show it, filling in whichever other boxes are empty. Runs before validation.
 */
function parseSettings(body: unknown): ConnectionInput {
  const raw = { ...((body ?? {}) as Record<string, unknown>) };
  const m = typeof raw.host === "string" ? /^mysqlx?:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?]+)(?::(\d+))?(?:\/([^?]*))?/i.exec(raw.host.trim()) : null;
  if (m) {
    raw.host = m[3];
    if (m[4]) raw.port = Number(m[4]);
    if (!raw.user && m[1]) raw.user = decodeURIComponent(m[1]);
    if (raw.password === undefined && m[2] !== undefined) raw.password = decodeURIComponent(m[2]);
    if (!raw.database && m[5]) raw.database = decodeURIComponent(m[5]);
  }
  return connectionInputSchema.parse(raw);
}

export function connectionsRouter(db: DB, opts: ConnectionsOptions) {
  const router = Router({ mergeParams: true });
  router.use(requireUser);
  const load = projectLoader(db);

  const getRow = (projectId: string, id: string) => {
    const row = db.prepare("SELECT * FROM connections WHERE id = ? AND project_id = ?").get(id, projectId) as ConnectionRow | undefined;
    if (!row) throw httpError(404, "That connection no longer exists. It may have been deleted.");
    return row;
  };
  const settingsOf = (row: ConnectionRow): ConnectionSettings => ({
    host: row.host,
    port: row.port,
    database: row.database,
    user: row.username,
    password: row.password_enc ? opts.secrets.decrypt(row.password_enc) : "",
    ssl: row.ssl,
  });
  const project = (req: { params: Record<string, string>; user?: { id: string } }, need: "view" | "edit" = "view") =>
    load(req.params.id, req.user!.id, need).row;

  /** Errors from MySQL go back as data (shown like the mysql client), not as HTTP failures. */
  const mysqlError = (e: unknown) => {
    const err = toMySqlError(e);
    return { errno: err.errno, sqlState: err.sqlState, message: err.message };
  };

  router.get("/", (req, res) => {
    const p = project(req);
    const rows = db.prepare("SELECT * FROM connections WHERE project_id = ? ORDER BY name COLLATE NOCASE").all(p.id) as ConnectionRow[];
    res.json({ connections: rows.map(info) });
  });

  router.post("/", (req, res) => {
    const p = project(req, "edit");
    const input = parseSettings(req.body);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM connections WHERE project_id = ?").get(p.id) as { n: number }).n;
    if (count >= MAX_CONNECTIONS) throw httpError(400, `A database can have up to ${MAX_CONNECTIONS} connections.`);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO connections (id, project_id, name, host, port, database, username, password_enc, ssl, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, p.id, input.name, input.host, input.port, input.database, input.user, input.password ? opts.secrets.encrypt(input.password) : "", input.ssl, req.user!.id, now, now);
    res.status(201).json({ connection: info(getRow(p.id, id)) });
  });

  router.put("/:cid", (req, res) => {
    const p = project(req, "edit");
    const row = getRow(p.id, req.params.cid);
    const input = parseSettings(req.body);
    // No password in the request means keep the saved one.
    const enc = input.password === undefined ? row.password_enc : input.password ? opts.secrets.encrypt(input.password) : "";
    db.prepare(
      "UPDATE connections SET name = ?, host = ?, port = ?, database = ?, username = ?, password_enc = ?, ssl = ?, updated_at = ? WHERE id = ?",
    ).run(input.name, input.host, input.port, input.database, input.user, enc, input.ssl, new Date().toISOString(), row.id);
    res.json({ connection: info(getRow(p.id, row.id)) });
  });

  router.delete("/:cid", (req, res) => {
    const p = project(req, "edit");
    db.prepare("DELETE FROM connections WHERE id = ? AND project_id = ?").run(req.params.cid, p.id);
    res.json({ ok: true });
  });

  /** Test Connection: the settings in the dialog (unsaved), falling back to the saved password. */
  router.post("/test", async (req, res) => {
    const p = project(req, "edit");
    const body = z.object({ connectionId: z.string().optional(), settings: z.unknown() }).parse(req.body);
    const input = parseSettings(body.settings);
    let password = input.password;
    if (password === undefined && body.connectionId) {
      const row = getRow(p.id, body.connectionId);
      password = row.password_enc ? opts.secrets.decrypt(row.password_enc) : "";
    }
    try {
      res.json({ ok: true, ...(await testConnection(settingsFrom(input, password ?? ""), opts.allowPrivateHosts)) });
    } catch (e) {
      res.json({ ok: false, error: mysqlError(e) });
    }
  });

  router.get("/:cid/tables", async (req, res) => {
    const p = project(req);
    const row = getRow(p.id, req.params.cid);
    if (!row.database) throw httpError(400, "Set a database name on this connection to list its tables.");
    try {
      res.json({ tables: await withConnection(settingsOf(row), opts.allowPrivateHosts, listTables) });
    } catch (e) {
      res.status(502).json({ error: mysqlError(e).message, mysql: mysqlError(e) });
    }
  });

  /** Foreign keys of the connection's database, so linked tables can be joined like related tables (any role). */
  router.get("/:cid/foreign-keys", async (req, res) => {
    const p = project(req);
    const row = getRow(p.id, req.params.cid);
    if (!row.database) throw httpError(400, "Set a database name on this connection to read its foreign keys.");
    try {
      res.json({ foreignKeys: await withConnection(settingsOf(row), opts.allowPrivateHosts, listForeignKeys) });
    } catch (e) {
      res.status(502).json({ error: mysqlError(e).message, mysql: mysqlError(e) });
    }
  });

  /** Browse a linked table (any role). */
  router.get("/:cid/tables/:table/rows", async (req, res) => {
    const p = project(req);
    const row = getRow(p.id, req.params.cid);
    const offset = Math.max(0, Number(req.query.offset ?? 0) | 0);
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 500) | 0));
    try {
      res.json(await withConnection(settingsOf(row), opts.allowPrivateHosts, (c) => browseTable(c, req.params.table, offset, limit)));
    } catch (e) {
      res.status(502).json({ error: mysqlError(e).message, mysql: mysqlError(e) });
    }
  });

  /** SQL console: one statement per request, any kind (editors and owners only). */
  router.post("/:cid/sql", async (req, res) => {
    const p = project(req, "edit");
    const row = getRow(p.id, req.params.cid);
    const { sql } = z.object({ sql: z.string().trim().min(1, "Type a SQL statement").max(200_000) }).parse(req.body);
    try {
      res.json(await withConnection(settingsOf(row), opts.allowPrivateHosts, (c) => runSql(c, sql, MAX_CONSOLE_ROWS)));
    } catch (e) {
      const err = mysqlError(e);
      res.json({ kind: "error", errno: err.errno, sqlState: err.sqlState, code: null, message: err.message, elapsedMs: 0 });
    }
  });

  /** Import tables as local tables: returns them for the browser to add (one undoable step). */
  router.post("/:cid/import", async (req, res) => {
    const p = project(req, "edit");
    const row = getRow(p.id, req.params.cid);
    const { tables } = z.object({ tables: z.array(z.string().min(1).max(64)).min(1, "Choose at least one table").max(100) }).parse(req.body);
    let exchange;
    try {
      exchange = await withConnection(settingsOf(row), opts.allowPrivateHosts, (c) => readTablesForImport(c, tables, MAX_IMPORT_ROWS));
    } catch (e) {
      if (e instanceof MySqlError || (e as { sqlMessage?: string }).sqlMessage || (e as { code?: string }).code) {
        res.status(502).json({ error: mysqlError(e).message });
        return;
      }
      throw e;
    }
    const { doc, warnings } = fromExchangeDocument(exchange);
    if (JSON.stringify(doc).length > MAX_IMPORT_BYTES) throw httpError(400, "Those tables hold more than about 20 MB of data. Import fewer tables.");
    res.json({ doc, warnings });
  });

  return router;
}
