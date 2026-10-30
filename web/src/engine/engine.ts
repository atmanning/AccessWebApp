import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { CellValue, Field, ProjectDoc, SourceRef, TableDef } from "../../../shared/model";
import { isSelect, SqlSyntaxError, translateAccessSql } from "./accessSql";
import { analyzeUpdatable } from "./updatable";

export interface ResultSet {
  columns: string[];
  /** Best guess at each column's Access field, used for display formatting. */
  fields: (Field | undefined)[];
  rows: CellValue[][];
  /** Present when editing was requested: how each cell maps back to a table record. */
  edit?: QueryEditInfo;
}

export type QueryEditInfo =
  | { ok: false; reason: string }
  | {
      ok: true;
      /** The table behind each source in the query's FROM clause. */
      tables: TableDef[];
      /** Per result column: which source and field it edits, or null if calculated. */
      columns: ({ source: number; fieldId: string } | null)[];
      /** Per result row, per source: the table row's `_id`. */
      rowIds: (string | null)[][];
    };

let sqlPromise: Promise<SqlJsStatic> | null = null;
const loadSql = () => (sqlPromise ??= initSqlJs({ locateFile: () => wasmUrl }));

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

function sqliteType(f: Field) {
  switch (f.type) {
    case "AutoNumber":
    case "YesNo":
      return "INTEGER";
    case "Number":
      return f.numberSize === "Single" || f.numberSize === "Double" ? "REAL" : "INTEGER";
    case "Currency":
      return "REAL";
    default:
      return "TEXT";
  }
}

function toSqlite(v: CellValue | undefined): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

/** Access built-in functions people use in queries, added to SQLite. */
function registerAccessFunctions(db: Database) {
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const datePart = (v: unknown, from: number, len: number) => {
    const s = str(v);
    return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? Number(s.slice(from, from + len)) : null;
  };
  const nowIso = () => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  };
  const fns: Record<string, (...a: never[]) => unknown> = {
    nz: (v: unknown, d: unknown = "") => (v === null ? d : v),
    len: (v: unknown) => (v === null ? null : String(v).length),
    left: (v: unknown, n: number) => str(v)?.slice(0, n) ?? null,
    right: (v: unknown, n: number) => (str(v) === null ? null : n <= 0 ? "" : str(v)!.slice(-n)),
    mid: (v: unknown, start: number, n?: number) =>
      str(v)?.substr(Math.max(0, start - 1), n ?? undefined) ?? null,
    ucase: (v: unknown) => str(v)?.toUpperCase() ?? null,
    lcase: (v: unknown) => str(v)?.toLowerCase() ?? null,
    year: (v: unknown) => datePart(v, 0, 4),
    month: (v: unknown) => datePart(v, 5, 2),
    day: (v: unknown) => datePart(v, 8, 2),
    now: () => nowIso(),
    date: () => nowIso().slice(0, 10),
    cstr: (v: unknown) => str(v),
    cint: (v: unknown) => (v === null ? null : Math.round(Number(v))),
    clng: (v: unknown) => (v === null ? null : Math.round(Number(v))),
    cdbl: (v: unknown) => (v === null ? null : Number(v)),
    ccur: (v: unknown) => (v === null ? null : Math.round(Number(v) * 10000) / 10000),
    val: (v: unknown) => {
      const m = /^\s*[-+]?\d*\.?\d+/.exec(String(v ?? ""));
      return m ? Number(m[0]) : 0;
    },
    isnull: (v: unknown) => (v === null ? 1 : 0),
  };
  // sql.js registers a function for exactly fn.length arguments, so functions with optional
  // arguments are registered once per arity.
  const optionalArgs: Record<string, number[]> = { nz: [1, 2], mid: [2, 3] };
  for (const [name, fn] of Object.entries(fns)) {
    for (const arity of optionalArgs[name] ?? [fn.length]) {
      const wrapper = (...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args);
      Object.defineProperty(wrapper, "length", { value: arity });
      db.create_function(name, wrapper as (...a: unknown[]) => never);
    }
  }
}

function loadTables(db: Database, tables: TableDef[]) {
  for (const t of tables) {
    if (!t.fields.length) continue;
    db.run(`CREATE TABLE ${ident(t.name)} (${t.fields.map((f) => `${ident(f.name)} ${sqliteType(f)}`).join(", ")})`);
    const stmt = db.prepare(
      `INSERT INTO ${ident(t.name)} VALUES (${t.fields.map(() => "?").join(", ")})`,
    );
    // Rows go in in order, so SQLite rowid N is t.rows[N - 1] (used to edit query results).
    for (const r of t.rows) stmt.run(t.fields.map((f) => toSqlite(r[f.id])));
    stmt.free();
  }
}

/**
 * Builds an in-memory SQLite database from the project and runs one SELECT.
 * Saved queries are available to each other as views, like in Access.
 */
export async function runQuery(
  doc: ProjectDoc,
  accessSql: string,
  opts: { maxRows?: number; excludeQueryId?: string; /** Work out which cells can be edited. */ editable?: boolean } = {},
): Promise<ResultSet> {
  if (!accessSql.trim()) throw new SqlSyntaxError("The query is empty. Add fields in Design View or type SQL.");
  if (!isSelect(accessSql)) {
    throw new SqlSyntaxError("Only SELECT queries can run here. Update, append and delete queries aren't supported yet.");
  }
  const SQL = await loadSql();
  const db = new SQL.Database();
  try {
    registerAccessFunctions(db);
    db.run("BEGIN");
    loadTables(db, doc.tables);
    // Make saved queries usable from other queries. Queries can depend on each other, so keep
    // retrying until no more succeed; ones that never work are skipped (they report their own
    // error when opened).
    let pending = doc.queries.filter((q) => q.id !== opts.excludeQueryId && q.sql.trim() && isSelectSafe(q.sql));
    while (pending.length) {
      const failed = pending.filter((q) => {
        try {
          db.run(`CREATE VIEW ${ident(q.name)} AS ${translateAccessSql(q.sql).replace(/;\s*$/, "")}`);
          return false;
        } catch {
          return true;
        }
      });
      if (failed.length === pending.length) break;
      pending = failed;
    }
    db.run("COMMIT");

    const updatable = opts.editable ? analyzeUpdatable(doc, accessSql) : null;
    const translated = translateAccessSql(updatable?.ok ? updatable.sql : accessSql).replace(/;\s*$/, "");
    let stmt;
    try {
      stmt = db.prepare(translated);
    } catch (e) {
      throw new SqlSyntaxError(friendlySqlError((e as Error).message));
    }
    const columns = stmt.getColumnNames();
    const rows: CellValue[][] = [];
    const max = opts.maxRows ?? 50_000;
    while (stmt.step()) {
      if (rows.length >= max) break;
      rows.push(stmt.get().map((v) => (v instanceof Uint8Array ? "(binary)" : (v as CellValue))));
    }
    stmt.free();
    if (!updatable) return { columns, fields: columns.map((c) => guessField(doc, c)), rows };
    if (!updatable.ok) return { columns, fields: columns.map((c) => guessField(doc, c)), rows, edit: updatable };

    // Split off the hidden rowid columns and map rowids (insertion order) to row ids.
    const n = updatable.sources.length;
    const shown = columns.slice(0, columns.length - n);
    if (shown.length !== updatable.columns.length) {
      // The SELECT list didn't parse the way SQLite ran it; play safe.
      return { columns: shown, fields: shown.map((c) => guessField(doc, c)), rows: rows.map((r) => r.slice(0, shown.length)), edit: { ok: false, reason: "This query's results can't be edited." } };
    }
    const rowIds = rows.map((r) =>
      updatable.sources.map((s, i) => {
        const rowid = r[shown.length + i];
        return typeof rowid === "number" ? ((s.table.rows[rowid - 1]?._id as string | undefined) ?? null) : null;
      }),
    );
    return {
      columns: shown,
      fields: shown.map((c, i) => updatable.columns[i]?.field ?? guessField(doc, c)),
      rows: rows.map((r) => r.slice(0, shown.length)),
      edit: {
        ok: true,
        tables: updatable.sources.map((s) => s.table),
        columns: updatable.columns.map((c) => (c ? { source: c.source, fieldId: c.field.id } : null)),
        rowIds,
      },
    };
  } finally {
    db.close();
  }
}

function isSelectSafe(sql: string) {
  try {
    return isSelect(sql);
  } catch {
    return false;
  }
}

function guessField(doc: ProjectDoc, column: string): Field | undefined {
  const matches = doc.tables.flatMap((t) => t.fields.filter((f) => f.name.toLowerCase() === column.toLowerCase()));
  if (!matches.length) return undefined;
  return matches.every((m) => m.type === matches[0].type || (isNum(m) && isNum(matches[0]))) ? matches[0] : undefined;
}
const isNum = (f: Field) => f.type === "Number" || f.type === "AutoNumber";

function friendlySqlError(msg: string) {
  const m = /no such (table|column): (.+)/.exec(msg);
  if (m) return `Access Web can't find the ${m[1] === "table" ? "table or query" : "field"} '${m[2]}'. Check the spelling.`;
  if (/syntax error/.test(msg)) return `Syntax error in query: ${msg.replace(/^.*?syntax error/, "syntax error")}.`;
  return msg;
}

/** Rows of a table or query as name-keyed records, for forms and reports. */
export async function readSource(doc: ProjectDoc, source: SourceRef): Promise<ResultSet & { table?: TableDef }> {
  if (source.kind === "table") {
    const t = doc.tables.find((x) => x.id === source.id);
    if (!t) throw new Error("The table this object is based on was deleted.");
    return {
      table: t,
      columns: t.fields.map((f) => f.name),
      fields: t.fields,
      rows: t.rows.map((r) => t.fields.map((f) => r[f.id] ?? null)),
    };
  }
  const q = doc.queries.find((x) => x.id === source.id);
  if (!q) throw new Error("The query this object is based on was deleted.");
  return runQuery(doc, q.sql, { excludeQueryId: q.id });
}
