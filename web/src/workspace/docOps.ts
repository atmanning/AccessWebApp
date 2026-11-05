/** Pure helpers that change a project document (used inside immer recipes). */
import {
  defaultFieldProps,
  LOOKUP_TYPES,
  NAME_PATTERN,
  type Field,
  type FieldType,
  type ObjectKind,
  type ProjectDoc,
  type TableDef,
} from "../../../shared/model";
import { convertValue } from "../engine/values";

export const newId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

export const KIND_LABEL: Record<ObjectKind, string> = { table: "Table", query: "Query", form: "Form", report: "Report", linked: "Linked Table" };
export const KIND_PLURAL: Record<ObjectKind, string> = { table: "Tables", query: "Queries", form: "Forms", report: "Reports", linked: "Linked Tables" };

export function objectsOf(doc: ProjectDoc, kind: ObjectKind): { id: string; name: string }[] {
  return { table: doc.tables, query: doc.queries, form: doc.forms, report: doc.reports, linked: doc.linkedTables ?? [] }[kind];
}

export function findObject(doc: ProjectDoc, kind: ObjectKind, id: string) {
  return objectsOf(doc, kind).find((o) => o.id === id);
}

/** Tables and queries share one namespace in Access; forms and reports each have their own. */
function nameTaken(doc: ProjectDoc, kind: ObjectKind, name: string, exceptId?: string) {
  const lower = name.toLowerCase();
  // Tables, linked tables and queries share one namespace in Access; forms and reports each have their own.
  const pool = kind === "table" || kind === "query" || kind === "linked" ? [...doc.tables, ...doc.queries, ...(doc.linkedTables ?? [])] : objectsOf(doc, kind);
  return pool.some((o) => o.id !== exceptId && o.name.toLowerCase() === lower);
}

export function validateObjectName(doc: ProjectDoc, kind: ObjectKind, name: string, exceptId?: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a name.";
  if (n.length > 64) return "Names can be at most 64 characters.";
  if (!NAME_PATTERN.test(n)) return "Names can't contain a period (.), exclamation point (!), accent grave (`) or brackets ([ ]).";
  if (nameTaken(doc, kind, n, exceptId)) {
    return kind === "table" || kind === "query"
      ? `A table or query named '${n}' already exists.`
      : `A ${KIND_LABEL[kind].toLowerCase()} named '${n}' already exists.`;
  }
  return null;
}

export function uniqueObjectName(doc: ProjectDoc, kind: ObjectKind, base: string) {
  if (!nameTaken(doc, kind, base)) return base;
  const m = /^(.*?)(\d+)$/.exec(base);
  const stem = m ? m[1] : base;
  for (let i = m ? Number(m[2]) + 1 : 1; ; i++) {
    const n = `${stem}${i}`;
    if (!nameTaken(doc, kind, n)) return n;
  }
}

export function validateFieldName(table: TableDef, name: string, exceptId?: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a field name.";
  if (!NAME_PATTERN.test(n)) return "Field names can't contain . ! ` [ or ] and can be at most 64 characters.";
  if (table.fields.some((f) => f.id !== exceptId && f.name.toLowerCase() === n.toLowerCase())) {
    return `The field name '${n}' is already used in this table.`;
  }
  return null;
}

export function uniqueFieldName(table: TableDef, base = "Field") {
  for (let i = 1; ; i++) {
    const n = `${base}${i}`;
    if (!table.fields.some((f) => f.name.toLowerCase() === n.toLowerCase())) return n;
  }
}

export function newTable(doc: ProjectDoc, name?: string): TableDef {
  const t: TableDef = {
    id: newId("t"),
    name: name ?? uniqueObjectName(doc, "table", "Table1"),
    fields: [{ id: newId("f"), name: "ID", type: "AutoNumber", primaryKey: true }],
    rows: [],
    nextAutoNumber: 1,
  };
  doc.tables.push(t);
  return t;
}

export function renameObject(doc: ProjectDoc, kind: ObjectKind, id: string, name: string) {
  const obj = findObject(doc, kind, id);
  if (!obj) return;
  const old = obj.name;
  obj.name = name;
  // Tables and saved queries can both be sources in a query's design.
  if (kind === "table" || kind === "query") {
    for (const q of doc.queries) {
      if (!q.design) continue;
      for (const j of q.design.joins ?? []) {
        if (j.t1 === old) j.t1 = name;
        if (j.t2 === old) j.t2 = name;
      }
      q.design.tables = q.design.tables.map((t) => (t === old ? name : t));
      for (const c of q.design.columns) if (c.table === old) c.table = name;
      if (q.design.boxes?.[old]) {
        q.design.boxes[name] = q.design.boxes[old];
        delete q.design.boxes[old];
      }
    }
  }
}

/** Removes an object and everything that only makes sense with it. */
export function deleteObject(doc: ProjectDoc, kind: ObjectKind, id: string) {
  if (kind === "table") {
    doc.tables = doc.tables.filter((t) => t.id !== id);
    doc.relationships = doc.relationships.filter((r) => r.fromTable !== id && r.toTable !== id);
  } else if (kind === "query") doc.queries = doc.queries.filter((q) => q.id !== id);
  else if (kind === "linked") doc.linkedTables = (doc.linkedTables ?? []).filter((t) => t.id !== id);
  else if (kind === "form") doc.forms = doc.forms.filter((f) => f.id !== id);
  else doc.reports = doc.reports.filter((r) => r.id !== id);
  if (doc.relationshipLayout?.[id]) delete doc.relationshipLayout[id];
  // Lookup fields that listed this table or query go back to plain text boxes.
  if (kind === "table" || kind === "query") {
    for (const t of doc.tables) for (const f of t.fields) if (f.lookup && f.lookup.rowSourceType === kind && f.lookup.rowSource === id) delete f.lookup;
  }
}

/** Objects whose record source is this table or query. */
export function dependents(doc: ProjectDoc, kind: ObjectKind, id: string): string[] {
  if (kind !== "table" && kind !== "query") return [];
  return [...doc.forms, ...doc.reports].filter((o) => o.source.kind === kind && o.source.id === id).map((o) => o.name);
}

export function renameField(doc: ProjectDoc, table: TableDef, fieldId: string, name: string) {
  const f = table.fields.find((x) => x.id === fieldId);
  if (!f) return;
  const old = f.name;
  f.name = name;
  for (const o of [...doc.forms, ...doc.reports]) {
    if (o.source.kind === "table" && o.source.id === table.id) {
      o.columns = o.columns.map((c) => (c === old ? name : c));
      if ("groupBy" in o && o.groupBy === old) o.groupBy = name;
      if ("sortBy" in o && o.sortBy === old) o.sortBy = name;
      if ("layout" in o && o.layout) {
        for (const c of o.layout.controls) {
          if (c.field === old) {
            if (c.label === old) c.label = name;
            if (c.type === "checkbox" && c.caption === old) c.caption = name;
            c.field = name;
          }
        }
      }
    }
    // Combo and list boxes that look values up in this table.
    for (const c of ("layout" in o && o.layout?.controls) || []) {
      if (c.rowSourceType === "table" && c.rowSource === table.id) {
        if (c.boundColumn === old) c.boundColumn = name;
        if (c.displayColumn === old) c.displayColumn = name;
      }
    }
  }
  // Lookup fields that list this table's values.
  for (const t of doc.tables) {
    for (const lf of t.fields) {
      if (lf.lookup?.rowSourceType === "table" && lf.lookup.rowSource === table.id) {
        if (lf.lookup.boundColumn === old) lf.lookup.boundColumn = name;
        if (lf.lookup.displayColumn === old) lf.lookup.displayColumn = name;
      }
    }
  }
  for (const q of doc.queries) {
    for (const c of q.design?.columns ?? []) if (c.table === table.name && c.field === old) c.field = name;
    for (const j of q.design?.joins ?? []) {
      if (j.t1 === table.name && j.f1 === old) j.f1 = name;
      if (j.t2 === table.name && j.f2 === old) j.f2 = name;
    }
  }
}

/** Changes a field's type, converting existing data. Returns how many values were lost. */
export function changeFieldType(table: TableDef, fieldId: string, type: FieldType): number {
  const f = table.fields.find((x) => x.id === fieldId);
  if (!f || f.type === type) return 0;
  const next: Field = {
    id: f.id,
    name: f.name,
    description: f.description,
    required: f.required,
    primaryKey: f.primaryKey,
    indexed: f.indexed,
    type,
    ...defaultFieldProps(type),
    // A lookup stays when the new type can have one (Short Text, Number).
    ...(f.lookup && LOOKUP_TYPES.includes(type) ? { lookup: f.lookup } : {}),
  };
  let lost = 0;
  if (type === "AutoNumber") {
    let n = 1;
    for (const r of table.rows) r[f.id] = n++;
    table.nextAutoNumber = n;
  } else {
    for (const r of table.rows) {
      const { value, lost: l } = convertValue(next, r[f.id]);
      if (l) lost++;
      r[f.id] = value;
    }
  }
  Object.keys(f).forEach((k) => delete (f as Record<string, unknown>)[k]);
  Object.assign(f, next);
  return lost;
}

export function countLostOnTypeChange(table: TableDef, fieldId: string, type: FieldType): number {
  const f = table.fields.find((x) => x.id === fieldId);
  if (!f || type === "AutoNumber") return 0;
  const next = { ...f, type, ...defaultFieldProps(type) } as Field;
  return table.rows.filter((r) => convertValue(next, r[f.id]).lost).length;
}

export function deleteField(doc: ProjectDoc, table: TableDef, fieldId: string) {
  const name = table.fields.find((f) => f.id === fieldId)?.name;
  table.fields = table.fields.filter((f) => f.id !== fieldId);
  // Lookups that stored or showed this field fall back to their defaults.
  for (const t of doc.tables) {
    for (const lf of t.fields) {
      if (lf.lookup?.rowSourceType === "table" && lf.lookup.rowSource === table.id) {
        if (lf.lookup.boundColumn === name) delete lf.lookup.boundColumn;
        if (lf.lookup.displayColumn === name) delete lf.lookup.displayColumn;
      }
    }
  }
  for (const r of table.rows) delete r[fieldId];
  doc.relationships = doc.relationships.filter(
    (r) => !(r.fromTable === table.id && r.fromField === fieldId) && !(r.toTable === table.id && r.toField === fieldId),
  );
}
