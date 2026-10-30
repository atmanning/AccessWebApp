import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { CellValue, Field, ProjectDoc, SourceRef, TableDef } from "../../../shared/model";
import { isSelect, SqlSyntaxError, tokenize, translateAccessSql } from "./accessSql";
import { parseStatement, type Statement } from "./statements";
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

/** Access totals SQLite lacks: StDev/StDevP, Var/VarP, First, Last. */
function registerAccessAggregates(db: Database) {
  type Agg = { init: () => unknown; step: (state: never, value: unknown) => unknown; finalize: (state: never) => unknown };
  const numbers = (): Agg => ({
    init: () => [] as number[],
    step: ((s: number[], v: unknown) => (v === null || v === undefined || Number.isNaN(Number(v)) ? s : (s.push(Number(v)), s))) as never,
    finalize: (() => null) as never,
  });
  const variance = (sample: boolean) => (s: number[]) => {
    const n = s.length;
    if (n < (sample ? 2 : 1)) return null;
    const mean = s.reduce((a, b) => a + b, 0) / n;
    return s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - (sample ? 1 : 0));
  };
  const aggs: Record<string, Agg> = {
    stdev: { ...numbers(), finalize: ((s: number[]) => { const v = variance(true)(s); return v === null ? null : Math.sqrt(v); }) as never },
    stdevp: { ...numbers(), finalize: ((s: number[]) => { const v = variance(false)(s); return v === null ? null : Math.sqrt(v); }) as never },
    var: { ...numbers(), finalize: variance(true) as never },
    varp: { ...numbers(), finalize: variance(false) as never },
    first: { init: () => ({ set: false, v: null }), step: ((s: { set: boolean; v: unknown }, v: unknown) => (s.set ? s : { set: true, v })) as never, finalize: ((s: { v: unknown }) => s.v) as never },
    last: { init: () => null, step: ((_s: unknown, v: unknown) => v) as never, finalize: ((s: unknown) => s) as never },
  };
  const withAgg = db as unknown as { create_aggregate: (name: string, agg: Agg) => void };
  for (const [name, agg] of Object.entries(aggs)) withAgg.create_aggregate(name, agg);
}

/**
 * Builds an in-memory SQLite database from the project: one table per Access table
 * (rowid N = t.rows[N - 1]) and saved select queries as views, like in Access.
 */
export async function openEngine(doc: ProjectDoc, opts: { excludeQueryId?: string } = {}): Promise<Database> {
  const SQL = await loadSql();
  const db = new SQL.Database();
  try {
    registerAccessFunctions(db);
    registerAccessAggregates(db);
    db.run("BEGIN");
    loadTables(db, doc.tables);
    // Queries can depend on each other, so keep retrying until no more succeed; ones that
    // never work are skipped (they report their own error when opened).
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
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

/** Runs one Access-SQL SELECT on an open engine database. */
export function selectRows(db: Database, accessSql: string, max = 50_000): { columns: string[]; rows: CellValue[][] } {
  let stmt;
  try {
    stmt = db.prepare(translateAccessSql(accessSql).replace(/;\s*$/, ""));
  } catch (e) {
    throw new SqlSyntaxError(friendlySqlError((e as Error).message));
  }
  try {
    const columns = stmt.getColumnNames();
    const rows: CellValue[][] = [];
    while (stmt.step()) {
      if (rows.length >= max) break;
      rows.push(stmt.get().map((v) => (v instanceof Uint8Array ? "(binary)" : (v as CellValue))));
    }
    return { columns, rows };
  } catch (e) {
    throw new SqlSyntaxError(friendlySqlError((e as Error).message));
  } finally {
    stmt.free();
  }
}

/**
 * Runs a select or crosstab query and returns its results. Action queries are run with
 * runAction (actions.ts); their Datasheet View shows previewAction's results.
 */
export async function runQuery(
  doc: ProjectDoc,
  accessSql: string,
  opts: { maxRows?: number; excludeQueryId?: string; /** Work out which cells can be edited. */ editable?: boolean } = {},
): Promise<ResultSet> {
  if (!accessSql.trim()) throw new SqlSyntaxError("The query is empty. Add fields in Design View or type SQL.");
  const statement = parseStatement(accessSql);
  if (statement.kind !== "select" && statement.kind !== "crosstab") {
    throw new SqlSyntaxError("This is an action query. Click Run to apply it; Datasheet View previews the records it changes.");
  }
  const db = await openEngine(doc, opts);
  try {
    if (statement.kind === "crosstab") return runCrosstab(doc, db, statement);
    const updatable = opts.editable ? analyzeUpdatable(doc, accessSql) : null;
    const { columns, rows } = selectRows(db, updatable?.ok ? updatable.sql : accessSql, opts.maxRows);
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

/**
 * TRANSFORM value SELECT rows... GROUP BY rows... PIVOT column: runs the grouped query with
 * the column heading added, then turns each distinct column heading into its own column.
 */
function runCrosstab(doc: ProjectDoc, db: Database, st: Extract<Statement, { kind: "crosstab" }>): ResultSet {
  const toks = tokenize(st.select);
  // Insert the pivot and value columns before FROM, and the pivot into GROUP BY.
  let depth = 0;
  let fromAt = -1;
  let groupAt = -1;
  let afterGroup = -1;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.text === "(") depth++;
    else if (t.text === ")") depth--;
    if (depth !== 0 || t.kind !== "word") continue;
    const w = t.text.toUpperCase();
    if (w === "FROM" && fromAt < 0) fromAt = t.start;
    if (w === "GROUP" && groupAt < 0) groupAt = t.start;
    if (groupAt >= 0 && (w === "HAVING" || w === "ORDER") && afterGroup < 0) afterGroup = t.start;
  }
  if (fromAt < 0) throw new SqlSyntaxError("The crosstab's SELECT part needs a FROM clause.");
  if (groupAt < 0) throw new SqlSyntaxError("A crosstab query needs GROUP BY for its row headings.");
  const sel = st.select;
  const groupEnd = afterGroup >= 0 ? afterGroup : sel.length;
  const sql =
    `${sel.slice(0, fromAt).trimEnd()}, (${st.pivot}) AS __pivot, ${st.value} AS __value ` +
    `${sel.slice(fromAt, groupEnd).trimEnd()}, (${st.pivot}) ${sel.slice(groupEnd)}`;
  const { columns, rows } = selectRows(db, sql);
  const heads = columns.length - 2;
  const label = (v: CellValue) => (v === null || v === undefined ? "<>" : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v));
  // Column headings: the IN list if given, else every value found, sorted.
  let pivots = st.pivotIn ?? [...new Set(rows.map((r) => label(r[heads])))];
  if (!st.pivotIn) {
    pivots = pivots.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (pivots.length > 250) throw new SqlSyntaxError("This crosstab would have more than 250 columns. Add criteria or use a different Column Heading.");
  }
  const out = new Map<string, CellValue[]>();
  for (const r of rows) {
    const key = JSON.stringify(r.slice(0, heads));
    let line = out.get(key);
    if (!line) out.set(key, (line = [...r.slice(0, heads), ...pivots.map(() => null as CellValue)]));
    const at = pivots.indexOf(label(r[heads]));
    if (at >= 0) line[heads + at] = r[heads + 1];
  }
  const headCols = columns.slice(0, heads);
  return {
    columns: [...headCols, ...pivots],
    fields: [...headCols.map((c) => guessField(doc, c)), ...pivots.map(() => undefined)],
    rows: [...out.values()],
    edit: { ok: false, reason: "Crosstab query results can't be edited." },
  };
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
