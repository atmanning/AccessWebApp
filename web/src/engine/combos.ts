/**
 * Combination keys: values that must be unique together, like PetType + Breed. They come from a
 * primary key made of several fields, or a unique index on several fields (Table Design → Indexes).
 * A combination is only checked once all its fields have a value, as in Access.
 */
import type { CellValue, Field, Row, TableDef } from "../../../shared/model";
import { formatDate } from "./values";

export interface Combination {
  /** "Primary key" or the index's name. */
  name: string;
  primary: boolean;
  fields: Field[];
}

/** The table's combinations that must be unique (two or more fields each). */
export function uniqueCombinations(table: TableDef): Combination[] {
  const out: Combination[] = [];
  const pk = table.fields.filter((f) => f.primaryKey);
  if (pk.length > 1) out.push({ name: "Primary key", primary: true, fields: pk });
  for (const ix of table.indexes ?? []) {
    if (!ix.unique) continue;
    const fields = ix.fields.map((id) => table.fields.find((f) => f.id === id)).filter((f): f is Field => !!f);
    if (fields.length > 1) out.push({ name: ix.name, primary: false, fields });
  }
  return out;
}

/** Text is compared without regard to capitals, like Access. */
const norm = (v: CellValue) => (typeof v === "string" ? v.toLowerCase() : v);
const blank = (v: CellValue | undefined) => v === null || v === undefined || v === "";
export const comboKey = (c: Combination, row: Row) => (c.fields.some((f) => blank(row[f.id])) ? null : JSON.stringify(c.fields.map((f) => norm(row[f.id] ?? null))));

/** "Dog" + "Beagle" */
export function comboValues(c: Combination, row: Row) {
  return c.fields
    .map((f) => {
      const v = row[f.id];
      return f.type === "DateTime" && typeof v === "string" ? formatDate(v) : typeof v === "string" ? `"${v}"` : String(v);
    })
    .join(" + ");
}
export const comboNames = (c: Combination) => {
  const n = c.fields.map((f) => f.name);
  return n.length === 2 ? `${n[0]} and ${n[1]}` : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
};

/** Why `row` (at `rowIdx`, or new) would repeat a combination another record has, or null. */
export function combinationError(table: TableDef, row: Row, rowIdx: number | "new"): string | null {
  for (const c of uniqueCombinations(table)) {
    const k = comboKey(c, row);
    if (k === null) continue;
    if (table.rows.some((r, i) => i !== rowIdx && comboKey(c, r) === k)) {
      return `The combination of ${comboNames(c)} must be unique, and ${comboValues(c, row)} is already used by another record. Please change one of them.`;
    }
  }
  return null;
}

/** For a new or changed index: the first combination the existing records already repeat, or null. */
export function firstDuplicate(table: TableDef, fields: Field[]): string | null {
  const c: Combination = { name: "", primary: false, fields };
  const seen = new Set<string>();
  for (const r of table.rows) {
    const k = comboKey(c, r);
    if (k === null) continue;
    if (seen.has(k)) return comboValues(c, r);
    seen.add(k);
  }
  return null;
}
