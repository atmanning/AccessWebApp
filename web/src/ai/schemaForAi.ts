/**
 * The database's design as plain text for the AI assistant: tables and fields with their types,
 * keys, lookups and relationships, saved queries, and, to help it write criteria, the values of
 * short text fields that only take a few (Status: Open, Closed). No other records are sent.
 */
import { FIELD_TYPE_LABELS, type ProjectDoc, type TableDef } from "../../../shared/model";

const MAX_CHOICES = 8;

/** A short list's values: only when they repeat (a category), never names, e-mails or other one-offs. */
function fewValues(t: TableDef, fieldId: string): string[] | null {
  if (t.rows.length < 6) return null;
  const seen = new Set<string>();
  let filled = 0;
  for (const r of t.rows) {
    const v = r[fieldId];
    if (v === null || v === undefined || v === "") continue;
    const s = String(v);
    if (s.includes("@") || /\d{3}/.test(s)) return null;
    filled++;
    seen.add(s.slice(0, 60));
    if (seen.size > MAX_CHOICES) return null;
  }
  return seen.size && seen.size * 2 <= filled ? [...seen] : null;
}

export function schemaForAi(doc: ProjectDoc, opts: { samples?: boolean } = {}): string {
  const lines: string[] = [];
  const tableName = (id: string) => doc.tables.find((t) => t.id === id)?.name ?? doc.queries.find((q) => q.id === id)?.name ?? id;
  for (const t of doc.tables) {
    lines.push(`Table [${t.name}]${t.description ? ` — ${t.description}` : ""} (${t.rows.length} records)`);
    for (const f of t.fields) {
      const bits = [FIELD_TYPE_LABELS[f.type] + (f.type === "ShortText" && f.size ? `(${f.size})` : "")];
      if (f.primaryKey) bits.push("primary key");
      if (f.required) bits.push("required");
      if (f.lookup?.rowSourceType === "values") bits.push(`choices: ${f.lookup.rowSource.split(/[;\n]/).map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean).slice(0, 20).join(", ")}`);
      else if (f.lookup) bits.push(`looks up [${tableName(f.lookup.rowSource)}]${f.lookup.displayColumn ? `, showing ${f.lookup.displayColumn}` : ""}`);
      else if (opts.samples !== false && f.type === "ShortText") {
        const vals = fewValues(t, f.id);
        if (vals) bits.push(`values: ${vals.map((v) => JSON.stringify(v)).join(", ")}`);
      }
      if (f.description) bits.push(`"${f.description}"`);
      lines.push(`  [${f.name}] ${bits.join("; ")}`);
    }
  }
  for (const l of doc.linkedTables ?? []) lines.push(`Linked table [${l.name}] (read-only)`);
  const field = (tid: string, fid: string) => doc.tables.find((t) => t.id === tid)?.fields.find((f) => f.id === fid)?.name ?? fid;
  if (doc.relationships.length) {
    lines.push("Relationships (one-to-many):");
    for (const r of doc.relationships) lines.push(`  [${tableName(r.fromTable)}].[${field(r.fromTable, r.fromField)}] -> [${tableName(r.toTable)}].[${field(r.toTable, r.toField)}]`);
  }
  if (doc.queries.length) {
    lines.push("Saved queries (usable like tables):");
    for (const q of doc.queries) lines.push(`  [${q.name}]: ${q.sql.replace(/\s+/g, " ").slice(0, 400)}`);
  }
  return lines.join("\n").slice(0, 60_000);
}
