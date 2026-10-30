/**
 * The "exchange" format passed to and from the Java Access tool (exporter/): tables with
 * ordered columns and rows, plus relationships and queries, all referenced by name.
 * This file converts an imported exchange document into a project document.
 */
import {
  FIELD_TYPES,
  NAME_PATTERN,
  NUMBER_SIZES,
  type CellValue,
  type Field,
  type ProjectDoc,
  type Row,
  type TableDef,
} from "./model.js";

export interface ExchangeColumn {
  name: string;
  type: string;
  size?: number;
  numberSize?: string;
  required?: boolean;
  primaryKey?: boolean;
  indexed?: string;
  description?: string;
  defaultValue?: string;
}

export interface ExchangeDocument {
  tables: { name: string; description?: string; columns: ExchangeColumn[]; rows: unknown[][] }[];
  relationships: { fromTable: string; fromColumn: string; toTable: string; toColumn: string; enforce: boolean }[];
  queries: { name: string; sql: string }[];
  warnings?: string[];
}

/** Name of the table our exporter writes saved queries into; importing it turns them back into queries. */
export const SAVED_QUERIES_TABLE = "_SavedQueries";

const rid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;

/** Makes a name valid for this app (Access forbids the same characters, but older files can be looser). */
export function cleanName(name: string, fallback: string): string {
  let n = String(name ?? "").replace(/[.!`[\]\u0000-\u001f]/g, "_").replace(/^\s+/, "").slice(0, 64);
  if (!n.trim()) n = fallback;
  return NAME_PATTERN.test(n) ? n : fallback;
}

function unique(name: string, taken: Set<string>): string {
  let n = name;
  for (let i = 1; taken.has(n.toLowerCase()); i++) {
    const suffix = String(i);
    n = name.slice(0, 64 - suffix.length) + suffix;
  }
  taken.add(n.toLowerCase());
  return n;
}

function toValue(field: Field, v: unknown): CellValue {
  if (v === null || v === undefined) return field.type === "YesNo" ? false : null;
  switch (field.type) {
    case "YesNo":
      return v === true || v === 1 || v === -1 || v === "true";
    case "AutoNumber":
    case "Number":
    case "Currency": {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case "ShortText":
      return String(v).slice(0, field.size ?? 255);
    default:
      return String(v);
  }
}

/** Converts an imported Access database into a project document. */
export function fromExchangeDocument(x: ExchangeDocument): { doc: ProjectDoc; warnings: string[] } {
  const warnings = [...(x.warnings ?? [])];
  const doc: ProjectDoc = { version: 1, tables: [], queries: [], forms: [], reports: [], relationships: [] };
  const objectNames = new Set<string>();
  const tableByOriginal = new Map<string, { table: TableDef; fieldByOriginal: Map<string, Field> }>();
  let savedQueries: { name: string; sql: string }[] = [];

  for (const t of x.tables ?? []) {
    // Our own exports keep query SQL in a table; turn it back into queries.
    if (t.name === SAVED_QUERIES_TABLE && t.columns.map((c) => c.name).join() === "QueryName,SQL") {
      savedQueries = t.rows.map((r) => ({ name: String(r[0] ?? ""), sql: String(r[1] ?? "") }));
      continue;
    }
    const name = unique(cleanName(t.name, "Table"), objectNames);
    if (name !== t.name) warnings.push(`Table '${t.name}' was renamed to '${name}'.`);
    const fieldNames = new Set<string>();
    const fieldByOriginal = new Map<string, Field>();
    const fields: Field[] = [];
    let hasAutoNumber = false;
    for (const c of t.columns) {
      let type = (FIELD_TYPES as readonly string[]).includes(c.type) ? (c.type as Field["type"]) : "ShortText";
      if (type === "AutoNumber" && hasAutoNumber) type = "Number";
      hasAutoNumber ||= type === "AutoNumber";
      const f: Field = { id: rid("f"), name: unique(cleanName(c.name, "Field"), fieldNames), type };
      if (type === "ShortText") f.size = Math.max(1, Math.min(255, c.size ?? 255));
      if (type === "Number") f.numberSize = (NUMBER_SIZES as readonly string[]).includes(c.numberSize ?? "") ? (c.numberSize as Field["numberSize"]) : "Long";
      if (c.required && type !== "AutoNumber" && type !== "YesNo") f.required = true;
      if (c.primaryKey) f.primaryKey = true;
      if ((c.indexed === "YesDup" || c.indexed === "YesNoDup") && type !== "LongText") f.indexed = c.indexed;
      if (c.description) f.description = c.description.slice(0, 255);
      if (c.defaultValue && type !== "AutoNumber") f.defaultValue = c.defaultValue.replace(/^=/, "").slice(0, 255);
      fields.push(f);
      fieldByOriginal.set(c.name, f);
    }
    const rows: Row[] = (t.rows ?? []).map((r) => {
      const row: Row = { _id: rid("r") };
      fields.forEach((f, i) => (row[f.id] = toValue(f, r[i])));
      return row;
    });
    const auto = fields.find((f) => f.type === "AutoNumber");
    const maxAuto = auto ? Math.max(0, ...rows.map((r) => (typeof r[auto.id] === "number" ? (r[auto.id] as number) : 0))) : 0;
    const table: TableDef = { id: rid("t"), name, fields, rows, nextAutoNumber: maxAuto + 1 };
    if (t.description) table.description = t.description.slice(0, 255);
    doc.tables.push(table);
    tableByOriginal.set(t.name, { table, fieldByOriginal });
  }

  for (const r of x.relationships ?? []) {
    const from = tableByOriginal.get(r.fromTable);
    const to = tableByOriginal.get(r.toTable);
    const ff = from?.fieldByOriginal.get(r.fromColumn);
    const tf = to?.fieldByOriginal.get(r.toColumn);
    if (!from || !to || !ff || !tf || from.table === to.table) continue;
    doc.relationships.push({ id: rid("rel"), fromTable: from.table.id, fromField: ff.id, toTable: to.table.id, toField: tf.id, enforce: !!r.enforce });
  }

  for (const q of [...(x.queries ?? []), ...savedQueries]) {
    if (!q.sql?.trim()) continue;
    const name = unique(cleanName(q.name, "Query"), objectNames);
    doc.queries.push({ id: rid("q"), name, mode: "sql", sql: q.sql.slice(0, 100_000) });
  }

  return { doc, warnings };
}

/**
 * Adds an imported database's objects to an existing one, renaming anything whose name is
 * already taken (as Access does: Customers -> Customers1).
 */
export function mergeProjects(target: ProjectDoc, incoming: ProjectDoc): { doc: ProjectDoc; renamed: string[] } {
  const taken = new Set([...target.tables, ...target.queries].map((o) => o.name.toLowerCase()));
  const renamed: string[] = [];
  const tables = incoming.tables.map((t) => {
    const name = unique(t.name, taken);
    if (name !== t.name) renamed.push(`${t.name} → ${name}`);
    return { ...t, name };
  });
  const queries = incoming.queries.map((q) => {
    const name = unique(q.name, taken);
    if (name !== q.name) renamed.push(`${q.name} → ${name}`);
    return { ...q, name };
  });
  return {
    doc: {
      ...target,
      tables: [...target.tables, ...tables],
      queries: [...target.queries, ...queries],
      relationships: [...target.relationships, ...incoming.relationships],
    },
    renamed,
  };
}
