import type { CellValue, Field, Row, TableDef } from "../../../shared/model";
import { defaultFor, formatDate, parseInput } from "../engine/values";
import { useDialogs } from "../ui/dialogs";
import { applyCascadeDeletes, applyKeyChange, describeCascades, planDelete, planKeyChange } from "../engine/integrity";
import { useWorkspace } from "./context";
import { newId } from "./docOps";

/**
 * Record-level editing rules shared by datasheets and forms: type validation,
 * primary key / no-duplicate checks, AutoNumber, defaults and referential integrity.
 */
export function useTableEditing(table: TableDef | undefined) {
  const { commitTo, deleteFrom } = useRecordEditing();
  return {
    commit: (rowIdx: number | "new", fieldId: string, input: string | boolean) =>
      table ? commitTo(table, rowIdx, fieldId, input) : "This record can't be edited.",
    deleteRows: (rows: number[]) => (table ? deleteFrom(table, rows) : Promise.resolve(false)),
  };
}

/** A value as it reads in a message: quoted text, plain numbers and dates. */
function shown(f: Field, v: CellValue): string {
  if (v === null || v === undefined) return "(blank)";
  if (f.type === "DateTime" && typeof v === "string") return formatDate(v);
  return typeof v === "string" ? `"${v}"` : String(v);
}

/** The same rules for any table, chosen per call (query results edit several tables). */
export function useRecordEditing() {
  const ws = useWorkspace();
  const dialogs = useDialogs();

  const uniquenessError = (table: TableDef, f: Field, value: CellValue, rowIdx: number | "new"): string | null => {
    if (!(f.primaryKey || f.indexed === "YesNoDup")) return null;
    if (f.primaryKey && (value === null || value === "")) return `${f.name} can't be left empty, because it identifies each record. Please enter a value.`;
    if (value === null || value === "") return null;
    // A multi-field primary key only needs the combination to be unique.
    if (f.primaryKey && table.fields.filter((x) => x.primaryKey).length > 1 && f.indexed !== "YesNoDup") return null;
    // Like Access, text is unique regardless of capitals ("smith" and "Smith" are the same).
    const key = (v: CellValue) => (typeof v === "string" ? v.toLowerCase() : v);
    const taken = table.rows.some((r, i) => i !== rowIdx && r[f.id] !== null && key(r[f.id]) === key(value));
    return taken ? `The value in ${f.name} must be unique, and ${shown(f, value)} is already used by another record. Please enter a different value.` : null;
  };

  /** Validates and saves one value. Returns an error message, or null on success. */
  const commitTo = (table: TableDef, rowIdx: number | "new", fieldId: string, input: string | boolean, preset?: Record<string, CellValue>): string | null => {
    const f = table.fields.find((x) => x.id === fieldId);
    if (!f) return "That field was deleted, so this can't be saved. Please re-open the table.";
    const parsed = parseInput(f, input);
    if (!parsed.ok) return parsed.error;
    const uniq = uniquenessError(table, f, parsed.value, rowIdx);
    if (uniq) return uniq;
    // Changing a key that related records point to would orphan them, unless the relationship
    // cascades the change to them.
    const keyChange = rowIdx !== "new" ? planKeyChange(ws.doc, table.id, f.id, table.rows[rowIdx][f.id], parsed.value) : null;
    if (keyChange?.blockedBy) {
      return `${f.name} can't be changed, because records in ${keyChange.blockedBy} use this value. To change them all together, turn on "Cascade Update Related Fields" for that relationship (Database Tools → Relationships).`;
    }
    for (const rel of ws.doc.relationships.filter((r) => r.enforce && r.toTable === table.id && r.toField === f.id)) {
      const parent = ws.doc.tables.find((t) => t.id === rel.fromTable);
      if (parsed.value !== null && parent && !parent.rows.some((pr) => pr[rel.fromField] === parsed.value)) {
        return `There's no ${parent.name} record with ${parent.fields.find((x) => x.id === rel.fromField)?.name ?? "that"} ${shown(f, parsed.value)}. Please choose one that exists, or add it to ${parent.name} first.`;
      }
    }
    ws.update((d) => {
      const t = d.tables.find((x) => x.id === table.id)!;
      if (rowIdx === "new") {
        const row: Row = { _id: newId("r") };
        for (const fld of t.fields) row[fld.id] = fld.type === "AutoNumber" ? t.nextAutoNumber++ : defaultFor(fld);
        // A subform's new record gets the link to the form's record (e.g. CustomerID).
        Object.assign(row, preset);
        row[f.id] = parsed.value;
        t.rows.push(row);
      } else {
        t.rows[rowIdx][f.id] = parsed.value;
        if (keyChange) applyKeyChange(d, keyChange, parsed.value);
      }
    });
    const carried = keyChange?.updates.reduce((n, u) => n + u.rowIds.length, 0) ?? 0;
    // Access checks required fields when you leave the record; here we remind instead of blocking.
    const valueOf = (x: Field) => (rowIdx === "new" ? defaultFor(x) : table.rows[rowIdx][x.id]);
    const missing = table.fields.filter((x) => x.required && x.id !== f.id && x.type !== "AutoNumber" && (valueOf(x) ?? "") === "");
    ws.setStatus(
      missing.length
        ? `Fill in the required field${missing.length > 1 ? "s" : ""}: ${missing.map((x) => x.name).join(", ")}.`
        : carried
          ? `Also changed ${f.name} in ${carried} related record${carried === 1 ? "" : "s"} (Cascade Update).`
          : "",
    );
    return null;
  };

  /** Asks for confirmation and deletes records (by index). Returns true if deleted. */
  const deleteFrom = async (table: TableDef, rows: number[]): Promise<boolean> => {
    if (!rows.length) return false;
    const plan = planDelete(ws.doc, table.id, rows.map((r) => table.rows[r]._id as string));
    if (plan.blockedBy) {
      await dialogs.alert(
        "Microsoft Access Web",
        `${rows.length === 1 ? "This record" : "These records"} can't be deleted, because records in ${plan.blockedBy} still use ${rows.length === 1 ? "it" : "them"}. Delete those first, or turn on "Cascade Delete Related Records" for that relationship (Database Tools → Relationships).`,
      );
      return false;
    }
    const also = describeCascades(ws.doc, plan);
    const ok = await dialogs.confirm(
      "Microsoft Access Web",
      also ? (
        <>
          <p>
            Relationships that specify cascading deletes are about to cause {rows.length} record(s) in this table and related records in other tables to be deleted:{" "}
            <strong>{also}</strong>.
          </p>
          <p>Are you sure you want to delete these records? You can bring them back with Undo (Ctrl+Z).</p>
        </>
      ) : (
        <>
          <p>You are about to delete {rows.length} record(s).</p>
          <p>Are you sure you want to delete these records? You can bring them back with Undo (Ctrl+Z).</p>
        </>
      ),
      { okLabel: "Yes", danger: true },
    );
    if (!ok) return false;
    const drop = new Set(rows);
    ws.update((d) => {
      const t = d.tables.find((x) => x.id === table.id)!;
      t.rows = t.rows.filter((_, i) => !drop.has(i));
      applyCascadeDeletes(d, plan);
    });
    ws.setStatus(`${rows.length} record(s) deleted${also ? `, with ${also}` : ""}.`);
    return true;
  };

  return { commitTo, deleteFrom };
}
