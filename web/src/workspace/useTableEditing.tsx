import type { CellValue, Field, Row, TableDef } from "../../../shared/model";
import { defaultFor, parseInput } from "../engine/values";
import { useDialogs } from "../ui/dialogs";
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

/** The same rules for any table, chosen per call (query results edit several tables). */
export function useRecordEditing() {
  const ws = useWorkspace();
  const dialogs = useDialogs();

  const uniquenessError = (table: TableDef, f: Field, value: CellValue, rowIdx: number | "new"): string | null => {
    if (!(f.primaryKey || f.indexed === "YesNoDup")) return null;
    if (f.primaryKey && (value === null || value === "")) return `${f.name} is the primary key, so it can't be empty.`;
    if (value === null || value === "") return null;
    // A multi-field primary key only needs the combination to be unique.
    if (f.primaryKey && table.fields.filter((x) => x.primaryKey).length > 1 && f.indexed !== "YesNoDup") return null;
    return table.rows.some((r, i) => i !== rowIdx && r[f.id] === value)
      ? `The changes you requested to the table were not successful because they would create duplicate values in ${f.name}. Change the data so there are no duplicates.`
      : null;
  };

  /** Validates and saves one value. Returns an error message, or null on success. */
  const commitTo = (table: TableDef, rowIdx: number | "new", fieldId: string, input: string | boolean, preset?: Record<string, CellValue>): string | null => {
    const f = table.fields.find((x) => x.id === fieldId);
    if (!f) return "That field no longer exists.";
    const parsed = parseInput(f, input);
    if (!parsed.ok) return parsed.error;
    const uniq = uniquenessError(table, f, parsed.value, rowIdx);
    if (uniq) return uniq;
    // Changing a key that related records point to would orphan them.
    if (rowIdx !== "new") {
      const old = table.rows[rowIdx][f.id];
      for (const rel of ws.doc.relationships.filter((r) => r.enforce && r.fromTable === table.id && r.fromField === f.id)) {
        const child = ws.doc.tables.find((t) => t.id === rel.toTable);
        if (old !== parsed.value && child?.rows.some((cr) => cr[rel.toField] === old)) {
          return `The record cannot be changed because table '${child.name}' includes related records.`;
        }
      }
    }
    for (const rel of ws.doc.relationships.filter((r) => r.enforce && r.toTable === table.id && r.toField === f.id)) {
      const parent = ws.doc.tables.find((t) => t.id === rel.fromTable);
      if (parsed.value !== null && parent && !parent.rows.some((pr) => pr[rel.fromField] === parsed.value)) {
        return `You cannot add or change a record because a related record is required in table '${parent.name}'.`;
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
      }
    });
    // Access checks required fields when you leave the record; here we remind instead of blocking.
    const valueOf = (x: Field) => (rowIdx === "new" ? defaultFor(x) : table.rows[rowIdx][x.id]);
    const missing = table.fields.filter((x) => x.required && x.id !== f.id && x.type !== "AutoNumber" && (valueOf(x) ?? "") === "");
    ws.setStatus(missing.length ? `Fill in the required field${missing.length > 1 ? "s" : ""}: ${missing.map((x) => x.name).join(", ")}.` : "");
    return null;
  };

  /** Asks for confirmation and deletes records (by index). Returns true if deleted. */
  const deleteFrom = async (table: TableDef, rows: number[]): Promise<boolean> => {
    if (!rows.length) return false;
    for (const rel of ws.doc.relationships.filter((r) => r.enforce && r.fromTable === table.id)) {
      const child = ws.doc.tables.find((t) => t.id === rel.toTable);
      if (!child) continue;
      const keys = new Set(rows.map((r) => table.rows[r][rel.fromField]));
      if (child.rows.some((cr) => keys.has(cr[rel.toField]))) {
        await dialogs.alert(
          "Microsoft Access Web",
          `The record cannot be deleted or changed because table '${child.name}' includes related records.`,
        );
        return false;
      }
    }
    const ok = await dialogs.confirm(
      "Microsoft Access Web",
      <>
        <p>You are about to delete {rows.length} record(s).</p>
        <p>Are you sure you want to delete these records? You can bring them back with Undo (Ctrl+Z).</p>
      </>,
      { okLabel: "Yes", danger: true },
    );
    if (!ok) return false;
    const drop = new Set(rows);
    ws.update((d) => {
      const t = d.tables.find((x) => x.id === table.id)!;
      t.rows = t.rows.filter((_, i) => !drop.has(i));
    });
    ws.setStatus(`${rows.length} record(s) deleted.`);
    return true;
  };

  return { commitTo, deleteFrom };
}
