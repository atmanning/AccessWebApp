/**
 * Lookup fields (Table Design → Lookup): the list of choices for each field, read from its row
 * source, for datasheets to show the display value and offer a drop-down.
 */
import { useEffect, useMemo, useState } from "react";
import type { Field, FieldLookup, ProjectDoc } from "../../../shared/model";
import { readSource } from "../engine/engine";
import { formatValue } from "../engine/values";
import { parseValueList } from "../forms/formLayout";

export interface LookupOption {
  /** The stored value, as text (what you'd type into the field). */
  value: string;
  /** What's shown instead of it. */
  label: string;
}

export interface ColumnLookup {
  options: LookupOption[];
  /** Only values in the list can be entered. */
  limit: boolean;
  /** Still reading a query's rows. */
  loading?: boolean;
}

/** The value list, or a table's/query's rows, as choices. Throws when the source is gone. */
export async function lookupOptions(doc: ProjectDoc, lookup: FieldLookup): Promise<LookupOption[]> {
  if (lookup.rowSourceType === "values") return parseValueList(lookup.rowSource).map((v) => ({ value: v, label: v }));
  const data = await readSource(doc, { kind: lookup.rowSourceType, id: lookup.rowSource });
  const find = (n?: string) => (n ? data.columns.findIndex((x) => x.toLowerCase() === n.toLowerCase()) : -1);
  const bi = Math.max(0, find(lookup.boundColumn));
  let di = find(lookup.displayColumn);
  if (di < 0) di = data.columns.length > 1 && !lookup.boundColumn ? 1 : bi;
  const seen = new Set<string>();
  const out: LookupOption[] = [];
  for (const r of data.rows) {
    if (r[bi] === null || r[bi] === undefined) continue;
    const v = String(r[bi]);
    if (seen.has(v)) continue;
    seen.add(v);
    out.push({ value: v, label: formatValue(data.fields[di], r[di]) || v });
  }
  // Sorted by what you see, like a lookup's ORDER BY in Access.
  return out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));
}

/** Whether a field's lookup still points at something that exists. */
export function lookupSourceExists(doc: ProjectDoc, lookup: FieldLookup): boolean {
  if (lookup.rowSourceType === "table") return doc.tables.some((t) => t.id === lookup.rowSource);
  if (lookup.rowSourceType === "query") return doc.queries.some((q) => q.id === lookup.rowSource);
  return true;
}

// Documents are immutable, so a changed source table is a new object: give each one a number.
const ids = new WeakMap<object, number>();
let nextId = 1;
function identity(x: unknown): string {
  if (!x || typeof x !== "object") return String(x ?? "");
  let n = ids.get(x);
  if (!n) ids.set(x, (n = nextId++));
  return `#${n}`;
}

/** Choices for each lookup field among `fields`, by field id. */
export function useFieldLookups(doc: ProjectDoc, fields: (Field | undefined)[]): Record<string, ColumnLookup> {
  const withLookup = fields.filter((f): f is Field & { lookup: FieldLookup } => !!f?.lookup && lookupSourceExists(doc, f.lookup));
  // Re-read when a lookup's settings or its source's data change.
  const sources = withLookup.map((f) =>
    f.lookup.rowSourceType === "table"
      ? doc.tables.find((t) => t.id === f.lookup.rowSource)
      : f.lookup.rowSourceType === "query"
        ? doc.queries.find((q) => q.id === f.lookup.rowSource)
        : f.lookup.rowSource,
  );
  const key = withLookup.map((f, i) => `${f.id}:${JSON.stringify(f.lookup)}:${identity(sources[i])}`).join("|");
  const [loaded, setLoaded] = useState<Record<string, LookupOption[]>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: Record<string, LookupOption[]> = {};
      for (const f of withLookup) out[f.id] = await lookupOptions(doc, f.lookup).catch(() => []);
      if (!cancelled) setLoaded(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stable between renders, so datasheets don't re-sort on every render.
  return useMemo(() => {
    const result: Record<string, ColumnLookup> = {};
    for (const f of withLookup) {
      result[f.id] = { options: loaded[f.id] ?? [], limit: f.lookup.limitToList !== false, loading: !loaded[f.id] };
    }
    return result;
  }, [key, loaded]); // eslint-disable-line react-hooks/exhaustive-deps
}
