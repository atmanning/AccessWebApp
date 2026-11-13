/**
 * Runs Access action queries (Make Table, Append, Update, Delete) against the project.
 *
 * The record selection and the new values are worked out by SQLite (so WHERE clauses,
 * joins and expressions behave exactly like select queries); the changes themselves are
 * then applied to the project document here, record by record, with the same rules as
 * typing in a datasheet. Like Access, records that would break a rule are skipped and
 * counted rather than failing the whole query.
 */
import { uniqueCombinations } from "./combos";
import { applyCascadeDeletes, applyKeyChange, describeCascades, planDelete as planCascadeDelete, planKeyChange, type DeletePlan } from "./integrity";
import {
  checkProjectIntegrity,
  defaultFieldProps,
  type CellValue,
  type Field,
  type ProjectDoc,
  type Row,
  type TableDef,
} from "../../../shared/model";
import { cleanName } from "../../../shared/exchange";
import { parseAccessDate, SqlSyntaxError } from "./accessSql";
import { openEngine, selectRows, type ResultSet } from "./engine";
import { parseStatement, type Statement } from "./statements";
import { analyzeUpdatable } from "./updatable";
import { defaultFor, parseInput } from "./values";

export interface ActionPlan {
  kind: "makeTable" | "append" | "update" | "delete";
  /** Records that will change (or be created). */
  count: number;
  /** "You are about to update 3 row(s)." */
  confirm: string;
  /** Set when an existing table is replaced (Make Table). */
  replaces?: string;
  /** Problems that skip records or blank values, as Access reports them. */
  problems: string[];
  /** Applies the change to a draft of the document. */
  apply: (draft: ProjectDoc) => void;
  /** "3 row(s) updated." */
  done: string;
}

const newId = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

/** Converts a value SQLite computed into what the field stores. */
function fromSql(field: Field, v: CellValue): { value: CellValue; failed: boolean } {
  if (v === null || v === undefined) return { value: field.type === "YesNo" ? false : null, failed: false };
  if (field.type === "YesNo") {
    if (typeof v === "number") return { value: v !== 0, failed: false };
    if (typeof v === "boolean") return { value: v, failed: false };
  }
  if (field.type === "DateTime" && typeof v === "string") {
    // Accepts 2026-10-30, 2026-10-30T13:05:00 (from Now()) and 10/30/2026.
    const iso = parseAccessDate(v);
    return iso ? { value: iso, failed: false } : { value: null, failed: true };
  }
  const r = parseInput(field, typeof v === "boolean" ? v : String(v));
  return r.ok ? { value: r.value, failed: false } : { value: null, failed: true };
}

const empty = (v: CellValue | undefined) => v === null || v === undefined || v === "";

/** Checks keys, required fields and relationships for a table's rows after a change. */
function violations(doc: ProjectDoc, table: TableDef, rows: Row[], changed: Set<string>, original: Map<string, Row>) {
  const key: Set<string> = new Set();
  const validation: Set<string> = new Set();
  const pk = table.fields.filter((f) => f.primaryKey);
  const unique = table.fields.filter((f) => f.indexed === "YesNoDup" && !f.primaryKey);
  // Duplicates: a changed row loses to any row that already had the value.
  const seen = (fields: Field[], skipIfAnyEmpty = false) => {
    // Text is unique regardless of capitals, like Access.
    const keyOf = (r: Row) => JSON.stringify(fields.map((f) => (typeof r[f.id] === "string" ? (r[f.id] as string).toLowerCase() : (r[f.id] ?? null))));
    const owners = new Map<string, string>();
    for (const r of rows) if (!changed.has(r._id as string)) owners.set(keyOf(r), r._id as string);
    for (const r of rows) {
      if (!changed.has(r._id as string)) continue;
      if (fields.every((f) => empty(r[f.id])) || (skipIfAnyEmpty && fields.some((f) => empty(r[f.id])))) continue;
      const k = keyOf(r);
      if (owners.has(k)) key.add(r._id as string);
      else owners.set(k, r._id as string);
    }
  };
  if (pk.length) seen(pk);
  for (const f of unique) seen([f]);
  // Unique indexes on several fields (PetType + Breed): checked once every part has a value.
  for (const c of uniqueCombinations(table)) if (!c.primary) seen(c.fields, true);
  for (const r of rows) {
    if (!changed.has(r._id as string)) continue;
    if (pk.some((f) => empty(r[f.id])) || table.fields.some((f) => f.required && f.type !== "AutoNumber" && empty(r[f.id]))) {
      validation.add(r._id as string);
    }
  }
  for (const rel of doc.relationships.filter((x) => x.enforce)) {
    // A related record must exist for a changed foreign key...
    if (rel.toTable === table.id) {
      const parent = doc.tables.find((t) => t.id === rel.fromTable);
      const keys = new Set(parent?.rows.map((p) => p[rel.fromField]));
      for (const r of rows) if (changed.has(r._id as string) && !empty(r[rel.toField]) && !keys.has(r[rel.toField])) key.add(r._id as string);
    }
    // ...and a key that related records use can't change, unless the change cascades to them.
    if (rel.fromTable === table.id) {
      for (const r of rows) {
        const before = original.get(r._id as string);
        if (changed.has(r._id as string) && before && before[rel.fromField] !== r[rel.fromField]) {
          if (planKeyChange(doc, table.id, rel.fromField, before[rel.fromField], r[rel.fromField]).blockedBy) key.add(r._id as string);
        }
      }
    }
  }
  return { key, validation };
}

function report(verb: string, conversion: number, key: number, validation: number): string[] {
  const out: string[] = [];
  if (conversion) out.push(`${conversion} value(s) don't fit their field's data type (for example text in a Number field), so they'll be left empty.`);
  if (key) out.push(`${key} record(s) won't be ${verb}, because a value that must be unique is already used, or a related record they need doesn't exist.`);
  if (validation) out.push(`${validation} record(s) won't be ${verb}, because a required field or the primary key would be empty.`);
  return out;
}

/** Works out the tables a FROM clause uses (with aliases), by asking the select-query analyser. */
function sourcesOf(doc: ProjectDoc, from: string) {
  const info = analyzeUpdatable(doc, `SELECT * FROM ${from}`);
  if (!info.ok) throw new SqlSyntaxError(info.reason.replace("This query's results can't be edited because", "This action query can't run because"));
  return info.sources;
}

function findSource(sources: ReturnType<typeof sourcesOf>, qualifier: string | undefined, field?: string) {
  if (qualifier) {
    const q = qualifier.toLowerCase();
    const i = sources.findIndex((s) => s.alias.toLowerCase() === q);
    const j = i >= 0 ? i : sources.findIndex((s) => s.table.name.toLowerCase() === q);
    if (j < 0) throw new SqlSyntaxError(`'${qualifier}' isn't one of the query's tables.`);
    return j;
  }
  if (sources.length === 1) return 0;
  const hits = sources.flatMap((s, i) => (s.table.fields.some((f) => f.name.toLowerCase() === field?.toLowerCase()) ? [i] : []));
  if (hits.length !== 1) throw new SqlSyntaxError(`Say which table '${field}' belongs to, like [Table].[${field}].`);
  return hits[0];
}

const fieldIn = (table: TableDef, name: string) => {
  const f = table.fields.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!f) throw new SqlSyntaxError(`The table '${table.name}' has no field named '${name}'.`);
  return f;
};

/** Datasheet View of an action query: the records it would change, as Access shows them. */
export async function previewAction(doc: ProjectDoc, sql: string, excludeQueryId?: string, extraTables?: TableDef[]): Promise<ResultSet> {
  const st = parseStatement(sql);
  const db = await openEngine(doc, { excludeQueryId, extraTables });
  try {
    let preview: string;
    if (st.kind === "update") {
      const sources = sourcesOf(doc, st.from);
      const cols = st.sets.map((s) => {
        const src = sources[findSource(sources, s.qualifier, s.field)];
        return `[${src.alias}].[${fieldIn(src.table, s.field).name}]`;
      });
      preview = `SELECT ${cols.join(", ")} FROM ${st.from}${st.where ? ` WHERE ${st.where}` : ""}`;
    } else if (st.kind === "delete") {
      const sources = sourcesOf(doc, st.from);
      const src = sources[findSource(sources, st.qualifier)];
      preview = `SELECT [${src.alias}].* FROM ${st.from}${st.where ? ` WHERE ${st.where}` : ""}`;
    } else if (st.kind === "append" || st.kind === "makeTable") preview = st.select;
    else throw new SqlSyntaxError("This isn't an action query.");
    const { columns, rows } = selectRows(db, preview);
    return { columns, fields: columns.map(() => undefined), rows, edit: { ok: false, reason: "This is a preview of the records the action query will change. Click Run to apply it." } };
  } finally {
    db.close();
  }
}

/** Works out exactly what an action query will do, without changing anything yet. */
export async function planAction(doc: ProjectDoc, sql: string, excludeQueryId?: string, extraTables?: TableDef[]): Promise<ActionPlan> {
  const st = parseStatement(sql);
  if (st.kind === "select" || st.kind === "crosstab") throw new SqlSyntaxError("This is a select query; it doesn't change data.");
  const db = await openEngine(doc, { excludeQueryId, extraTables });
  try {
    switch (st.kind) {
      case "update":
        return planUpdate(doc, db, st);
      case "delete":
        return planDelete(doc, db, st);
      case "append":
        return planAppend(doc, db, st);
      case "makeTable":
        return planMakeTable(doc, db, st);
    }
  } finally {
    db.close();
  }
}

type Db = Awaited<ReturnType<typeof openEngine>>;

function planUpdate(doc: ProjectDoc, db: Db, st: Extract<Statement, { kind: "update" }>): ActionPlan {
  const sources = sourcesOf(doc, st.from);
  const sets = st.sets.map((s) => {
    const si = findSource(sources, s.qualifier, s.field);
    return { si, field: fieldIn(sources[si].table, s.field), expr: s.expr };
  });
  if (!sets.length) throw new SqlSyntaxError("Type a value or expression in the Update To row.");
  if (sets.some((s) => s.field.type === "AutoNumber")) throw new SqlSyntaxError("AutoNumber fields are numbered automatically and can't be changed. Please take it out of the Update To row.");
  const used = [...new Set(sets.map((s) => s.si))];
  const select =
    `SELECT ${used.map((si) => `[${sources[si].alias}].rowid AS __r${si}`).join(", ")}, ` +
    `${sets.map((s, i) => `(${s.expr}) AS __v${i}`).join(", ")} FROM ${st.from}${st.where ? ` WHERE ${st.where}` : ""}`;
  const { rows } = selectRows(db, select, 1_000_000);
  // Changes per table, keyed by row id (a join can hit the same record more than once).
  const changes = new Map<string, Map<string, Record<string, CellValue>>>();
  let conversion = 0;
  for (const r of rows) {
    sets.forEach((s, i) => {
      const table = sources[s.si].table;
      const rowid = r[used.indexOf(s.si)];
      const row = typeof rowid === "number" ? table.rows[rowid - 1] : undefined;
      if (!row) return;
      const { value, failed } = fromSql(s.field, r[used.length + i]);
      if (failed) conversion++;
      const perTable = changes.get(table.id) ?? new Map();
      changes.set(table.id, perTable);
      const rowChanges = perTable.get(row._id as string) ?? {};
      perTable.set(row._id as string, { ...rowChanges, [s.field.id]: value });
    });
  }
  let key = 0;
  let validation = 0;
  let count = 0;
  const accepted = new Map<string, Map<string, Record<string, CellValue>>>();
  const cascades: { plan: ReturnType<typeof planKeyChange>; next: CellValue }[] = [];
  for (const [tableId, perRow] of changes) {
    const table = doc.tables.find((t) => t.id === tableId)!;
    const original = new Map(table.rows.map((r) => [r._id as string, r]));
    const after = table.rows.map((r) => (perRow.has(r._id as string) ? { ...r, ...perRow.get(r._id as string) } : r));
    const v = violations(doc, table, after, new Set(perRow.keys()), original);
    key += v.key.size;
    validation += [...v.validation].filter((id) => !v.key.has(id)).length;
    const ok = new Map([...perRow].filter(([id]) => !v.key.has(id) && !v.validation.has(id)));
    count += ok.size;
    accepted.set(tableId, ok);
    // Key changes that carry over to related records (Cascade Update Related Fields).
    const keyFields = new Set(doc.relationships.filter((r) => r.enforce && r.cascadeUpdate && r.fromTable === tableId).map((r) => r.fromField));
    for (const [id, c] of ok) {
      const before = original.get(id);
      for (const fid of Object.keys(c)) {
        if (before && keyFields.has(fid) && before[fid] !== c[fid]) cascades.push({ plan: planKeyChange(doc, tableId, fid, before[fid], c[fid]), next: c[fid] });
      }
    }
  }
  const carried = cascades.reduce((n, x) => n + x.plan.updates.reduce((m, u) => m + u.rowIds.length, 0), 0);
  return {
    kind: "update",
    count,
    confirm: `You are about to update ${count} row(s).`,
    problems: report("updated", conversion, key, validation),
    done: `${count} row(s) updated${carried ? `, and ${carried} related record(s) by Cascade Update` : ""}.`,
    apply: (draft) => {
      for (const [tableId, perRow] of accepted) {
        const t = draft.tables.find((x) => x.id === tableId);
        if (!t) continue;
        for (const row of t.rows) {
          const c = perRow.get(row._id as string);
          if (c) Object.assign(row, c);
        }
      }
      for (const c of cascades) applyKeyChange(draft, c.plan, c.next);
    },
  };
}

function planDelete(doc: ProjectDoc, db: Db, st: Extract<Statement, { kind: "delete" }>): ActionPlan {
  const sources = sourcesOf(doc, st.from);
  const src = sources[findSource(sources, st.qualifier)];
  const { rows } = selectRows(db, `SELECT [${src.alias}].rowid FROM ${st.from}${st.where ? ` WHERE ${st.where}` : ""}`, 1_000_000);
  const ids = new Set(rows.map((r) => (typeof r[0] === "number" ? (src.table.rows[r[0] - 1]?._id as string) : "")).filter(Boolean));
  // Records that related records still use can't be deleted, unless the relationship cascades the delete.
  let key = 0;
  const cascades: DeletePlan["cascades"] = new Map();
  for (const id of [...ids]) {
    const plan = planCascadeDelete(doc, src.table.id, [id]);
    if (plan.blockedBy) {
      ids.delete(id);
      key++;
      continue;
    }
    for (const [t, rows] of plan.cascades) cascades.set(t, new Set([...(cascades.get(t) ?? []), ...rows]));
  }
  const tableId = src.table.id;
  const also = describeCascades(doc, { cascades });
  return {
    kind: "delete",
    count: ids.size,
    confirm: `You are about to delete ${ids.size} row(s) from the table '${src.table.name}'${also ? `, and by cascading deletes ${also}` : ""}.`,
    problems: key ? [`${key} record(s) won't be deleted, because records in another table still use them. (Turn on "Cascade Delete Related Records" for that relationship to delete them together.)`] : [],
    done: `${ids.size} row(s) deleted from ${src.table.name}${also ? `, with ${also}` : ""}.`,
    apply: (draft) => {
      const t = draft.tables.find((x) => x.id === tableId);
      if (t) t.rows = t.rows.filter((r) => !ids.has(r._id as string));
      applyCascadeDeletes(draft, { cascades });
    },
  };
}

function planAppend(doc: ProjectDoc, db: Db, st: Extract<Statement, { kind: "append" }>): ActionPlan {
  const table = doc.tables.find((t) => t.name.toLowerCase() === st.target.toLowerCase());
  if (!table) throw new SqlSyntaxError(`The table '${st.target}' to append to doesn't exist.`);
  const { columns, rows } = selectRows(db, st.select, 1_000_000);
  const targetFields = (st.columns ?? table.fields.filter((f) => f.type !== "AutoNumber").map((f) => f.name)).map((n) => fieldIn(table, n));
  if (targetFields.length !== columns.length) {
    throw new SqlSyntaxError(`The query gives ${columns.length} column(s) but names ${targetFields.length} field(s) to put them in. Please make the two lists the same length.`);
  }
  return appendRowsPlan(doc, table, targetFields, rows);
}

/**
 * Adds rows (values in the order of `targetFields`) to a table with the same rules as an
 * append query: defaults, AutoNumbers, and skipping records that break keys or relationships.
 * Also used by Paste > Append Data to Existing Table.
 */
export function appendRowsPlan(doc: ProjectDoc, table: TableDef, targetFields: Field[], rows: CellValue[][]): ActionPlan {
  const auto = table.fields.find((f) => f.type === "AutoNumber");
  let next = table.nextAutoNumber;
  let conversion = 0;
  const added: Row[] = rows.map((r) => {
    const row: Row = { _id: newId("r") };
    for (const f of table.fields) row[f.id] = f.type === "AutoNumber" ? null : defaultFor(f);
    targetFields.forEach((f, i) => {
      const { value, failed } = fromSql(f.type === "AutoNumber" ? { ...f, type: "Number", numberSize: "Long" } : f, r[i]);
      if (failed) conversion++;
      row[f.id] = value;
    });
    if (auto) {
      if (empty(row[auto.id])) row[auto.id] = next++;
      else next = Math.max(next, Number(row[auto.id]) + 1);
    }
    return row;
  });
  const v = violations(doc, table, [...table.rows, ...added], new Set(added.map((r) => r._id as string)), new Map());
  const ok = added.filter((r) => !v.key.has(r._id as string) && !v.validation.has(r._id as string));
  const validation = [...v.validation].filter((id) => !v.key.has(id)).length;
  const tableId = table.id;
  const nextAuto = Math.max(table.nextAutoNumber, ...ok.map((r) => (auto ? Number(r[auto.id]) + 1 : 0)));
  return {
    kind: "append",
    count: ok.length,
    confirm: `You are about to append ${ok.length} row(s) to the table '${table.name}'.`,
    problems: report("added", conversion, v.key.size, validation),
    done: `${ok.length} row(s) appended to ${table.name}.`,
    apply: (draft) => {
      const t = draft.tables.find((x) => x.id === tableId);
      if (!t) return;
      t.rows.push(...ok);
      t.nextAutoNumber = Math.max(t.nextAutoNumber, nextAuto);
    },
  };
}

function planMakeTable(doc: ProjectDoc, db: Db, st: Extract<Statement, { kind: "makeTable" }>): ActionPlan {
  const name = cleanName(st.target, "");
  if (!name) throw new SqlSyntaxError(`'${st.target}' isn't a valid table name.`);
  if (doc.queries.some((q) => q.name.toLowerCase() === name.toLowerCase())) {
    throw new SqlSyntaxError(`A query is already named '${name}'. Choose another name for the new table.`);
  }
  const existing = doc.tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
  const { columns, rows } = selectRows(db, st.select, 1_000_000);
  if (!columns.length) throw new SqlSyntaxError("The query doesn't select any fields for the new table.");

  // Field types: copy the source field when the column is a plain field, else infer from the values.
  const taken = new Set<string>();
  const fields: Field[] = columns.map((col, i) => {
    let n = cleanName(col, `Field${i + 1}`);
    for (let k = 1; taken.has(n.toLowerCase()); k++) n = `${cleanName(col, "Field")}${k}`.slice(0, 64);
    taken.add(n.toLowerCase());
    const source = doc.tables.flatMap((t) => t.fields).find((f) => f.name.toLowerCase() === col.toLowerCase());
    const vals = rows.map((r) => r[i]).filter((v) => v !== null && v !== undefined);
    let type: Field["type"];
    let extra: Partial<Field> = {};
    if (source && source.type !== "AutoNumber") {
      type = source.type;
      extra = { size: source.size, numberSize: source.numberSize };
    } else if (source?.type === "AutoNumber" || (vals.length && vals.every((v) => typeof v === "number" && Number.isInteger(v)))) {
      type = "Number";
      extra = { numberSize: "Long" };
    } else if (vals.length && vals.every((v) => typeof v === "number")) {
      type = "Number";
      extra = { numberSize: "Double" };
    } else if (vals.some((v) => String(v).length > 255)) type = "LongText";
    else type = "ShortText";
    const f: Field = { id: newId("f"), name: n, type, ...defaultFieldProps(type) };
    if (extra.size) f.size = extra.size;
    if (extra.numberSize) f.numberSize = extra.numberSize;
    return f;
  });
  let conversion = 0;
  const newRows: Row[] = rows.map((r) => {
    const row: Row = { _id: newId("r") };
    fields.forEach((f, i) => {
      const { value, failed } = fromSql(f, r[i]);
      if (failed) conversion++;
      row[f.id] = value;
    });
    return row;
  });
  // Replacing a table keeps its id, so forms and reports based on it keep working.
  const table: TableDef = { id: existing?.id ?? newId("t"), name, fields, rows: newRows, nextAutoNumber: 1 };
  return {
    kind: "makeTable",
    count: newRows.length,
    confirm: `You are about to paste ${newRows.length} row(s) into a new table '${name}'.`,
    replaces: existing ? `The existing table '${existing.name}' will be deleted before the query runs.` : undefined,
    problems: conversion ? [`${conversion} value(s) don't fit their field's data type, so they'll be left empty.`] : [],
    done: `Created table ${name} with ${newRows.length} row(s).`,
    apply: (draft) => {
      const i = draft.tables.findIndex((t) => t.id === table.id);
      if (i >= 0) {
        draft.tables[i] = table;
        // Relationships pointed at the old table's fields, which no longer exist.
        draft.relationships = draft.relationships.filter((r) => r.fromTable !== table.id && r.toTable !== table.id);
      } else draft.tables.push(table);
      if (checkProjectIntegrity(draft).length) throw new SqlSyntaxError("The new table couldn't be made from this query. Please check its fields and try again.");
    },
  };
}
