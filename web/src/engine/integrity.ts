/**
 * Referential integrity with Access's two cascade options:
 *
 *   Cascade Update Related Fields   changing a key (e.g. a DepartmentID) changes it in the related
 *                                   records too, instead of being refused.
 *   Cascade Delete Related Records  deleting a record deletes the records that point to it, instead
 *                                   of being refused.
 *
 * Both follow chains (Departments → Employees → Timesheets) when each link allows it. A link that
 * doesn't block the change, naming its table, like Access's message.
 */
import type { CellValue, Field, ProjectDoc, Row } from "../../../shared/model";

/** Whether two fields can be related: the same data type (an AutoNumber matches a Long Integer Number). */
export function fieldsCompatible(a: Pick<Field, "type" | "numberSize">, b: Pick<Field, "type" | "numberSize">) {
  const norm = (f: Pick<Field, "type" | "numberSize">) => (f.type === "AutoNumber" ? "Number:Long" : f.type === "Number" ? `Number:${f.numberSize ?? "Long"}` : f.type);
  return norm(a) === norm(b);
}

/** The relationships a field change would leave with mismatched types: the other side's table names. */
export function relationshipsBrokenBy(doc: ProjectDoc, tableId: string, field: Field, change: Partial<Pick<Field, "type" | "numberSize">>): string[] {
  const next = { ...field, ...change };
  const out: string[] = [];
  for (const r of doc.relationships) {
    const mine = r.fromTable === tableId && r.fromField === field.id ? "from" : r.toTable === tableId && r.toField === field.id ? "to" : null;
    if (!mine) continue;
    const otherT = doc.tables.find((t) => t.id === (mine === "from" ? r.toTable : r.fromTable));
    const otherF = otherT?.fields.find((f) => f.id === (mine === "from" ? r.toField : r.fromField));
    if (otherT && otherF && fieldsCompatible(field, otherF) && !fieldsCompatible(next, otherF)) out.push(`${otherT.name}.${otherF.name}`);
  }
  return out;
}

const same = (a: CellValue | undefined, b: CellValue | undefined) => a === b || (a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b));

/** One table's key field change from `old` to `next`, and the related records it would carry along. */
export interface KeyChangePlan {
  /** The table whose related records stop the change (no Cascade Update on that link). */
  blockedBy?: string;
  /** Records in related tables whose field gets the new value: table id → field id → row ids. */
  updates: { tableId: string; fieldId: string; rowIds: string[] }[];
}

export function planKeyChange(doc: ProjectDoc, tableId: string, fieldId: string, old: CellValue, next: CellValue): KeyChangePlan {
  const updates: KeyChangePlan["updates"] = [];
  const seen = new Set<string>();
  const walk = (tId: string, fId: string): string | undefined => {
    if (seen.has(`${tId}:${fId}`)) return undefined;
    seen.add(`${tId}:${fId}`);
    for (const rel of doc.relationships.filter((r) => r.enforce && r.fromTable === tId && r.fromField === fId)) {
      const child = doc.tables.find((t) => t.id === rel.toTable);
      if (!child) continue;
      const rows = child.rows.filter((r) => same(r[rel.toField], old));
      if (!rows.length) continue;
      if (!rel.cascadeUpdate) return child.name;
      updates.push({ tableId: child.id, fieldId: rel.toField, rowIds: rows.map((r) => r._id as string) });
      // The child's field may itself be a key other tables point to.
      const deeper = walk(child.id, rel.toField);
      if (deeper) return deeper;
    }
    return undefined;
  };
  if (same(old, next)) return { updates };
  const blockedBy = walk(tableId, fieldId);
  return blockedBy ? { blockedBy, updates: [] } : { updates };
}

/** Applies a planned key change's related updates inside a document update. */
export function applyKeyChange(draft: ProjectDoc, plan: KeyChangePlan, next: CellValue) {
  for (const u of plan.updates) {
    const t = draft.tables.find((x) => x.id === u.tableId);
    if (!t) continue;
    const ids = new Set(u.rowIds);
    for (const r of t.rows) if (ids.has(r._id as string)) r[u.fieldId] = next;
  }
}

/** Records deleted from a table, and the related records that go with them. */
export interface DeletePlan {
  /** The table whose related records stop the delete (no Cascade Delete on that link). */
  blockedBy?: string;
  /** Related records deleted along with them: table id → row ids (not including the table itself). */
  cascades: Map<string, Set<string>>;
}

export function planDelete(doc: ProjectDoc, tableId: string, rowIds: Iterable<string>): DeletePlan {
  const cascades = new Map<string, Set<string>>();
  const going = new Map<string, Set<string>>([[tableId, new Set(rowIds)]]);
  const queue: [string, Row[]][] = [];
  const start = doc.tables.find((t) => t.id === tableId);
  if (start) queue.push([tableId, start.rows.filter((r) => going.get(tableId)!.has(r._id as string))]);
  while (queue.length) {
    const [tId, rows] = queue.shift()!;
    for (const rel of doc.relationships.filter((r) => r.enforce && r.fromTable === tId)) {
      const child = doc.tables.find((t) => t.id === rel.toTable);
      if (!child) continue;
      const keys = rows.map((r) => r[rel.fromField]).filter((v) => v !== null && v !== undefined && v !== "");
      const gone = going.get(child.id) ?? new Set<string>();
      const hit = child.rows.filter((cr) => !gone.has(cr._id as string) && keys.some((k) => same(cr[rel.toField], k)));
      if (!hit.length) continue;
      if (!rel.cascadeDelete) return { blockedBy: child.name, cascades: new Map() };
      for (const r of hit) gone.add(r._id as string);
      going.set(child.id, gone);
      const c = cascades.get(child.id) ?? new Set<string>();
      for (const r of hit) c.add(r._id as string);
      cascades.set(child.id, c);
      queue.push([child.id, hit]);
    }
  }
  return { cascades };
}

/** Applies a delete plan's related deletes inside a document update. */
export function applyCascadeDeletes(draft: ProjectDoc, plan: DeletePlan) {
  for (const [tId, ids] of plan.cascades) {
    const t = draft.tables.find((x) => x.id === tId);
    if (t) t.rows = t.rows.filter((r) => !ids.has(r._id as string));
  }
}

/** "3 records in Orders and 5 in Order Lines": what a cascade delete will also remove. */
export function describeCascades(doc: ProjectDoc, plan: DeletePlan): string {
  const parts = [...plan.cascades].map(([id, rows]) => `${rows.size} in ${doc.tables.find((t) => t.id === id)?.name ?? "another table"}`);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
