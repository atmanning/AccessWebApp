/**
 * Scan station rules: what a scanned name tag does. A tag's QR code carries the person's key
 * (…?rec=42); a scan action either adds a record (Attendance: PersonID 42, the time, "Session 2")
 * or changes a field on the person (Attended = Yes).
 */
import type { CellValue, Field, ProjectDoc, Row, ScanAction, TableDef } from "./model.js";
import { defaultFor, formatValue, parseInput } from "./values.js";
const newId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

/** The person's key in a scanned code: a tag's link (public report or record), or text typed or read by a barcode scanner. */
export function keyFromScan(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    const rec = u.searchParams.get("rec");
    return rec !== null && rec !== "" ? rec : null;
  } catch {
    return t.length <= 200 ? t : null;
  }
}

export const keyField = (t: TableDef | undefined): Field | undefined => {
  const pk = t?.fields.filter((f) => f.primaryKey) ?? [];
  return pk.length === 1 ? pk[0] : undefined;
};

/** How a person reads on screen: their name fields, or the first couple of text fields. */
export function personName(t: TableDef, row: Row): string {
  const named = t.fields.filter((f) => /name/i.test(f.name) && (f.type === "ShortText" || f.type === "LongText"));
  const fields = (named.length ? named : t.fields.filter((f) => f.type === "ShortText")).slice(0, 2);
  const text = fields.map((f) => row[f.id]).filter((v) => v !== null && v !== undefined && v !== "").join(" ");
  return text || `${keyField(t)?.name ?? "Record"} ${String(row[keyField(t)?.id ?? ""] ?? "")}`;
}

export const localNow = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
};

/** A typed value for a field ("Yes", "Now", a number…). */
function valueFor(f: Field, text: string, now: string): CellValue {
  if (f.type === "DateTime" && /^(=?\s*now(\(\))?|now)$/i.test(text.trim())) return now;
  if (f.type === "DateTime" && /^(=?\s*date(\(\))?|today)$/i.test(text.trim())) return now.slice(0, 10);
  const r = parseInput(f, text);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const same = (a: CellValue | undefined, b: CellValue | undefined) => a !== null && a !== undefined && b !== null && b !== undefined && String(a).toLowerCase() === String(b).toLowerCase();

export type ScanResult =
  | { ok: true; person: string; message: string; undo: { tableId: string; rowId: string; fieldId?: string; old?: CellValue } }
  | { ok: false; person?: string; message: string; already?: boolean };

/** What's wrong with an action's settings (a deleted table or field), or null. */
export function actionProblem(doc: ProjectDoc, a: ScanAction): string | null {
  const people = doc.tables.find((t) => t.id === a.people);
  if (!people) return "Its people table was deleted. Edit the scan action.";
  if (!keyField(people)) return `${people.name} needs a primary key (one field) so tags can tell people apart.`;
  if (a.kind === "add") {
    const t = doc.tables.find((x) => x.id === a.table);
    if (!t) return "Choose the table it adds records to.";
    if (!t.fields.some((f) => f.id === a.personField)) return `Choose the field of ${t.name} that stores the person.`;
  } else if (!people.fields.some((f) => f.id === a.field)) return "Choose the field it changes.";
  return null;
}

/**
 * Applies a scan inside a document update. Returns what happened, with what Undo needs.
 * Nothing changes when it fails.
 */
export function applyScan(doc: ProjectDoc, a: ScanAction, key: string, now: string = localNow()): ScanResult {
  const problem = actionProblem(doc, a);
  if (problem) return { ok: false, message: problem };
  const people = doc.tables.find((t) => t.id === a.people)!;
  const pk = keyField(people)!;
  const person = people.rows.find((r) => same(r[pk.id], key));
  if (!person) return { ok: false, message: `There's no one in ${people.name} with ${pk.name} ${key}. Was this tag printed from another database?` };
  const name = personName(people, person);

  try {
    if (a.kind === "set") {
      const f = people.fields.find((x) => x.id === a.field)!;
      const v = valueFor(f, a.value ?? "Yes", now);
      if (a.once && person[f.id] !== null && person[f.id] !== undefined && person[f.id] !== "" && (f.type === "DateTime" || same(person[f.id], v))) {
        return { ok: false, person: name, already: true, message: `Already marked: ${f.name} is ${formatValue(f, person[f.id]) || "set"}.` };
      }
      const old = person[f.id] ?? null;
      person[f.id] = v;
      return { ok: true, person: name, message: `${f.name}: ${formatValue(f, v)}`, undo: { tableId: people.id, rowId: person._id as string, fieldId: f.id, old } };
    }

    const t = doc.tables.find((x) => x.id === a.table)!;
    const pf = t.fields.find((x) => x.id === a.personField)!;
    const fixed: [Field, CellValue][] = Object.entries(a.values ?? {})
      .map(([id, text]) => [t.fields.find((x) => x.id === id), text] as const)
      .filter((x): x is readonly [Field, string] => !!x[0] && x[1].trim() !== "")
      .map(([f, text]) => [f, valueFor(f, text, now)]);
    const personValue = valueFor(pf, String(person[pk.id]), now);
    if (a.once) {
      const dup = t.rows.find((r) => same(r[pf.id], personValue) && fixed.every(([f, v]) => same(r[f.id], v)));
      if (dup) {
        const tf = t.fields.find((x) => x.id === a.timeField);
        return { ok: false, person: name, already: true, message: `Already recorded${tf && dup[tf.id] ? ` at ${formatValue(tf, dup[tf.id])}` : ""}.` };
      }
    }
    const row: Row = { _id: newId("r") };
    for (const f of t.fields) row[f.id] = f.type === "AutoNumber" ? t.nextAutoNumber++ : defaultFor(f);
    row[pf.id] = personValue;
    for (const [f, v] of fixed) row[f.id] = v;
    const tf = t.fields.find((x) => x.id === a.timeField);
    if (tf) row[tf.id] = now;
    t.rows.push(row);
    const what = fixed.map(([f, v]) => `${formatValue(f, v)}`).join(", ");
    return { ok: true, person: name, message: `Added to ${t.name}${what ? `: ${what}` : ""}`, undo: { tableId: t.id, rowId: row._id as string } };
  } catch (e) {
    return { ok: false, person: name, message: (e as Error).message };
  }
}

/** Whether a signed-in person may run an action: the owner and editors always; others when listed. */
export function mayRecord(a: ScanAction, user: { email: string } | null, role: "owner" | "edit" | "view" | null): boolean {
  if (!user) return false;
  if (role === "owner" || role === "edit") return true;
  return (a.recorders ?? []).some((e) => e.toLowerCase() === user.email.toLowerCase());
}

/** A scan action's state for one person: already done (with when), for "Take attendance ✓". */
export function scanStatus(doc: ProjectDoc, a: ScanAction, key: string): string | null {
  const people = doc.tables.find((t) => t.id === a.people);
  const pk = keyField(people);
  const person = pk && people!.rows.find((r) => same(r[pk.id], key));
  if (!person || !a.once) return null;
  if (a.kind === "set") {
    const f = people!.fields.find((x) => x.id === a.field);
    return f && person[f.id] !== null && person[f.id] !== undefined && person[f.id] !== "" ? `${f.name}: ${formatValue(f, person[f.id])}` : null;
  }
  const t = doc.tables.find((x) => x.id === a.table);
  const pf = t?.fields.find((x) => x.id === a.personField);
  if (!t || !pf) return null;
  const fixed = Object.entries(a.values ?? {}).filter(([, v]) => v.trim() !== "");
  const dup = t.rows.find(
    (r) =>
      same(r[pf.id], person[pk.id]) &&
      fixed.every(([id, text]) => {
        const f = t.fields.find((x) => x.id === id);
        if (!f) return true;
        try {
          return same(r[id], valueFor(f, text, localNow()));
        } catch {
          return false;
        }
      }),
  );
  if (!dup) return null;
  const tf = t.fields.find((x) => x.id === a.timeField);
  return tf && dup[tf.id] ? `Recorded ${formatValue(tf, dup[tf.id])}` : "Recorded";
}

/** Takes a scan back. */
export function undoScan(doc: ProjectDoc, u: { tableId: string; rowId: string; fieldId?: string; old?: CellValue }) {
  const t = doc.tables.find((x) => x.id === u.tableId);
  if (!t) return;
  if (u.fieldId) {
    const r = t.rows.find((x) => x._id === u.rowId);
    if (r) r[u.fieldId] = u.old ?? null;
  } else t.rows = t.rows.filter((x) => x._id !== u.rowId);
}

/**
 * A ready-made log table for a people table: an ID, the person (related, with referential
 * integrity), when, and what (e.g. the session or the achievement).
 */
export function makeLogTable(doc: ProjectDoc, people: TableDef, name: string, whatLabel: string): { table: TableDef; action: Omit<ScanAction, "id" | "name"> } {
  const pk = keyField(people)!;
  const id = newId("t");
  const f = (n: string, type: Field["type"], extra: Partial<Field> = {}): Field => ({ id: newId("f"), name: n, type, ...extra }) as Field;
  const idF = f(`${name.replace(/\s+/g, "")}ID`, "AutoNumber", { primaryKey: true, required: true });
  const personF = f(pk.name, "Number", { numberSize: pk.type === "AutoNumber" ? "Long" : pk.numberSize, required: true, indexed: "YesDup" });
  if (pk.type === "ShortText") Object.assign(personF, { type: "ShortText", size: pk.size ?? 255 });
  const whenF = f("ScannedAt", "DateTime");
  const whatF = f(whatLabel, "ShortText", { size: 100 });
  const table: TableDef = { id, name, fields: [idF, personF, whenF, whatF], rows: [], nextAutoNumber: 1 } as TableDef;
  doc.tables.push(table);
  doc.relationships.push({ id: newId("rel"), fromTable: people.id, fromField: pk.id, toTable: id, toField: personF.id, enforce: true, cascadeDelete: true });
  return { table, action: { people: people.id, kind: "add", table: id, personField: personF.id, timeField: whenF.id, values: { [whatF.id]: "" }, once: true } };
}
