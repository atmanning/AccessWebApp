/**
 * Builds a design from the AI assistant into ordinary objects: tables with keys, lookups and
 * relationships, optional sample records, a form for each table, and the starter queries and reports.
 * Everything can be opened in Design View and changed like anything you made yourself.
 */
import type { AiDatabaseSpec, AiFieldSpec } from "../../../shared/ai";
import type { CellValue, Field, ProjectDoc, Relationship, TableDef } from "../../../shared/model";
import { autoLayout } from "../forms/formLayout";
import { sqlToDesign } from "../engine/sqlToDesign";
import { newId, uniqueObjectName } from "../workspace/docOps";

export interface BuildResult {
  tables: { id: string; name: string }[];
  forms: { id: string; name: string }[];
  queries: { id: string; name: string }[];
  reports: { id: string; name: string }[];
  /** Things that didn't fit (a reference to a table that isn't there…), for the person to know. */
  notes: string[];
}

const lower = (s: string) => s.trim().toLowerCase();

function cellFor(f: Field, v: unknown): CellValue {
  if (v === null || v === undefined || v === "") return null;
  switch (f.type) {
    case "AutoNumber":
    case "Number":
    case "Currency": {
      const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "YesNo":
      return typeof v === "boolean" ? v : /^(yes|true|1|y)$/i.test(String(v));
    case "DateTime": {
      const s = String(v).trim();
      if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(s)) return s.replace("T", " ");
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    }
    case "ShortText":
      return String(v).slice(0, f.size ?? 255);
    default:
      return String(v);
  }
}

/** Swaps table names the design used for the names they got here (a name already taken gets a number). */
function renameInSql(sql: string, renamed: Map<string, string>): string {
  if (!renamed.size) return sql;
  return sql.replace(/\[([^\]]+)\]/g, (m, n: string) => {
    const to = renamed.get(lower(n));
    return to ? `[${to}]` : m;
  });
}

export function buildDatabase(doc: ProjectDoc, spec: AiDatabaseSpec, opts: { sampleData?: boolean; adding?: boolean } = {}): BuildResult {
  const out: BuildResult = { tables: [], forms: [], queries: [], reports: [], notes: [] };
  const renamed = new Map<string, string>();
  const made: { spec: AiDatabaseSpec["tables"][number]; table: TableDef; specFields: (AiFieldSpec | null)[] }[] = [];

  // Tables and fields.
  for (const ts of spec.tables) {
    // Adding to a database: a table it already has is used as it is.
    if (opts.adding && doc.tables.some((t) => lower(t.name) === lower(ts.name))) {
      out.notes.push(`${ts.name} is already in this database, so the existing table was used.`);
      continue;
    }
    const name = uniqueObjectName(doc, "table", ts.name);
    if (name !== ts.name) renamed.set(lower(ts.name), name);
    const fields: Field[] = [];
    const specFields: (AiFieldSpec | null)[] = [];
    const used = new Set<string>();
    const add = (f: Field, s: AiFieldSpec | null) => {
      let n = f.name.slice(0, 64);
      for (let i = 2; used.has(lower(n)); i++) n = `${f.name.slice(0, 60)}${i}`;
      used.add(lower(n));
      fields.push({ ...f, name: n });
      specFields.push(s);
    };
    // Every table gets an AutoNumber key, first.
    const keySpec = ts.fields.find((f) => f.type === "AutoNumber");
    add({ id: newId("f"), name: keySpec?.name ?? "ID", type: "AutoNumber", primaryKey: true }, keySpec ?? null);
    for (const fs of ts.fields) {
      if (fs === keySpec || fs.type === "AutoNumber") continue;
      const f: Field = { id: newId("f"), name: fs.name, type: fs.references ? "Number" : fs.type };
      if (f.type === "ShortText") f.size = fs.size ?? 255;
      if (f.type === "Number") f.numberSize = "Long";
      if (fs.required) f.required = true;
      if (fs.description) f.description = fs.description.slice(0, 255);
      if (fs.defaultValue) f.defaultValue = fs.defaultValue.slice(0, 255);
      if (fs.references) f.indexed = "YesDup";
      if (fs.choices?.length && !fs.references && (f.type === "ShortText" || f.type === "Number")) {
        f.lookup = { display: "combo", rowSourceType: "values", rowSource: fs.choices.map((c) => c.replace(/;/g, ",")).join(";"), limitToList: true };
      }
      add(f, fs);
    }
    const table: TableDef = { id: newId("t"), name, fields, rows: [], nextAutoNumber: 1 };
    if (ts.description) table.description = ts.description.slice(0, 255);
    doc.tables.push(table);
    made.push({ spec: ts, table, specFields });
    out.tables.push({ id: table.id, name });
  }

  // References: a relationship from the other table's key, and a drop-down showing its first text field.
  const tableNamed = (n: string) => made.find((m) => lower(m.spec.name) === lower(n))?.table ?? doc.tables.find((t) => lower(t.name) === lower(n));
  for (const m of made) {
    m.specFields.forEach((fs, i) => {
      if (!fs?.references) return;
      const field = m.table.fields[i];
      const target = tableNamed(fs.references);
      const key = target?.fields.find((f) => f.primaryKey) ?? target?.fields[0];
      if (!target || !key) {
        out.notes.push(`${m.table.name}.${field.name} was meant to point to "${fs.references}", which isn't in the design, so it's a plain number field.`);
        return;
      }
      const shown = target.fields.find((f) => f.type === "ShortText" && !f.primaryKey);
      field.lookup = { display: "combo", rowSourceType: "table", rowSource: target.id, boundColumn: key.name, ...(shown ? { displayColumn: shown.name } : {}), limitToList: true };
      const rel: Relationship = { id: newId("rel"), fromTable: target.id, fromField: key.id, toTable: m.table.id, toField: field.id, enforce: true };
      doc.relationships.push(rel);
    });
  }

  // Sample records.
  if (opts.sampleData) {
    for (const m of made) {
      const rows = m.spec.sampleRows ?? [];
      rows.forEach((sr, i) => {
        const byName = new Map(Object.entries(sr).map(([k, v]) => [lower(k), v]));
        const row: Record<string, CellValue> & { _id: string } = { _id: newId("r") };
        m.table.fields.forEach((f, fi) => {
          const v = byName.get(lower(f.name)) ?? byName.get(lower(m.specFields[fi]?.name ?? ""));
          row[f.id] = f.type === "AutoNumber" ? (cellFor(f, v) ?? i + 1) : cellFor(f, v);
        });
        m.table.rows.push(row);
      });
      const key = m.table.fields[0];
      m.table.nextAutoNumber = Math.max(0, ...m.table.rows.map((r) => Number(r[key.id]) || 0)) + 1;
    }
    // A reference to a record that isn't there is left blank, so the relationship holds.
    for (const rel of doc.relationships) {
      const to = made.find((m) => m.table.id === rel.toTable)?.table;
      const from = doc.tables.find((t) => t.id === rel.fromTable);
      if (!to || !from) continue;
      const keys = new Set(from.rows.map((r) => r[rel.fromField]));
      for (const r of to.rows) if (r[rel.toField] !== null && !keys.has(r[rel.toField])) r[rel.toField] = null;
    }
  }

  // A form for each table.
  for (const m of made) {
    const id = newId("fm");
    const name = uniqueObjectName(doc, "form", m.table.name);
    doc.forms.push({
      id,
      name,
      title: m.table.name,
      source: { kind: "table", id: m.table.id },
      columns: m.table.fields.map((f) => f.name),
      layout: autoLayout(m.table.name, m.table.fields.map((f) => ({ name: f.name, field: f }))),
    });
    out.forms.push({ id, name });
  }

  // Starter queries (in Design View when they fit it).
  const queryIds = new Map<string, string>();
  for (const qs of spec.queries ?? []) {
    const sql = renameInSql(qs.sql, renamed);
    const id = newId("q");
    const name = uniqueObjectName(doc, "query", qs.name);
    const design = sqlToDesign(doc, sql);
    doc.queries.push(design.ok ? { id, name, mode: "design", sql, design: design.design } : { id, name, mode: "sql", sql });
    queryIds.set(lower(qs.name), id);
    out.queries.push({ id, name });
  }

  // Reports.
  for (const rs of spec.reports ?? []) {
    const t = tableNamed(renamed.get(lower(rs.source)) ?? rs.source);
    const qid = queryIds.get(lower(rs.source));
    if (!t && !qid) {
      out.notes.push(`The report "${rs.name}" was meant to show "${rs.source}", which isn't in the design, so it was left out.`);
      continue;
    }
    const known = t ? new Map(t.fields.map((f) => [lower(f.name), f.name])) : null;
    const col = (c: string) => (known ? known.get(lower(c)) : c);
    const columns = rs.columns.map(col).filter((c): c is string => !!c);
    if (!columns.length) continue;
    const id = newId("rp");
    const name = uniqueObjectName(doc, "report", rs.name);
    const groupBy = rs.groupBy ? col(rs.groupBy) : undefined;
    const sortBy = rs.sortBy ? col(rs.sortBy) : undefined;
    doc.reports.push({
      id,
      name,
      title: rs.name,
      source: t ? { kind: "table", id: t.id } : { kind: "query", id: qid! },
      columns,
      ...(groupBy ? { groupBy } : {}),
      ...(sortBy ? { sortBy } : {}),
    });
    out.reports.push({ id, name });
  }
  return out;
}
