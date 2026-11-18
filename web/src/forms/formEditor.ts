/**
 * Saving a form's records: straight to its table, or, for a form based on a query, through the
 * query to the table each column comes from (as Access does with updatable queries). A query that
 * reads one table can add and delete records too; one that joins tables can edit the fields of
 * each existing record.
 */
import type { CellValue, TableDef } from "../../../shared/model";
import type { ResultSet } from "../engine/engine";
import { useRecordEditing } from "../workspace/useTableEditing";
import { useWorkspace } from "../workspace/context";

export interface FormEditor {
  /** Why a column can't be edited, or null when it can. */
  readOnlyReason(col: number): string | null;
  /** Saves one value; `row` indexes data.rows. `preset` fills more columns of a new record (a subform's link). */
  commit(row: number | "new", col: number, input: string | boolean, preset?: Record<string, CellValue>): string | null;
  canAdd: boolean;
  canDelete: boolean;
  deleteRows(rows: number[]): Promise<boolean>;
  /** A stable key for a record (its table row's id), so it can be found again after the data changes. */
  keyOf(row: number): string;
  /** The key of the record most recently added (after commit "new"). */
  lastAddedKey(): string | null;
}

export function useFormEditor(data: ResultSet | undefined, table: TableDef | undefined): FormEditor {
  const ws = useWorkspace();
  const { commitTo, deleteFrom } = useRecordEditing();
  const latest = (id: string) => ws.getDoc().tables.find((t) => t.id === id);
  const edit = data?.edit?.ok ? data.edit : null;
  /** The one table a query reads (it can add and delete records there). */
  const single = edit && edit.tables.length === 1 ? edit.tables[0].id : null;
  let addedIn: string | null = null;

  const presetFor = (t: TableDef, preset: Record<string, CellValue> | undefined) => {
    if (!preset) return undefined;
    const out: Record<string, CellValue> = {};
    for (const [name, v] of Object.entries(preset)) {
      // By column name: the query's column, else the table's field of that name.
      const ci = data ? data.columns.findIndex((c) => c.toLowerCase() === name.toLowerCase()) : -1;
      const m = ci >= 0 && edit ? edit.columns[ci] : null;
      const fid = m && edit!.tables[m.source].id === t.id ? m.fieldId : t.fields.find((f) => f.name.toLowerCase() === name.toLowerCase())?.id;
      if (fid) out[fid] = v;
    }
    return out;
  };

  if (table) {
    return {
      readOnlyReason: (col) => (data?.fields[col] ? null : "This field can't be edited."),
      commit: (row, col, input, preset) => {
        const f = data?.fields[col];
        if (!f) return "This field can't be edited.";
        const t = latest(table.id) ?? table;
        const err = commitTo(t, row, f.id, input, row === "new" ? presetFor(t, preset) : undefined);
        if (!err && row === "new") addedIn = t.id;
        return err;
      },
      canAdd: true,
      canDelete: true,
      deleteRows: (rows) => deleteFrom(latest(table.id) ?? table, rows),
      keyOf: (i) => String(table.rows[i]?._id ?? i),
      lastAddedKey: () => lastKey(addedIn ? latest(addedIn) : undefined),
    };
  }

  if (!edit) {
    const reason = data?.edit && !data.edit.ok ? data.edit.reason : "This form's records come from a query that can't be edited.";
    return {
      readOnlyReason: () => reason,
      commit: () => reason,
      canAdd: false,
      canDelete: false,
      deleteRows: async () => false,
      keyOf: (i) => String(i),
      lastAddedKey: () => null,
    };
  }

  return {
    readOnlyReason: (col) => (edit.columns[col] ? null : `${data!.columns[col]} is calculated by the query, so it can't be edited.`),
    commit: (row, col, input, preset) => {
      const m = edit.columns[col];
      if (!m) return `${data!.columns[col]} is calculated by the query, so it can't be edited.`;
      const t = latest(edit.tables[m.source].id);
      if (!t) return "The table this field comes from was deleted.";
      if (row === "new") {
        if (!single || t.id !== single) return "New records can't be added through this query (it joins several tables). Add them in the table instead.";
        const err = commitTo(t, "new", m.fieldId, input, presetFor(t, preset));
        if (!err) addedIn = t.id;
        return err;
      }
      const rowId = edit.rowIds[row]?.[m.source];
      const idx = rowId ? t.rows.findIndex((r) => r._id === rowId) : -1;
      if (idx < 0) return "This record was deleted.";
      return commitTo(t, idx, m.fieldId, input);
    },
    canAdd: !!single,
    canDelete: !!single,
    deleteRows: async (rows) => {
      const t = single ? latest(single) : undefined;
      if (!t) return false;
      const ids = new Set<unknown>(rows.map((r) => edit.rowIds[r]?.[0]));
      return deleteFrom(
        t,
        t.rows.flatMap((r, i) => (ids.has(r._id) ? [i] : [])),
      );
    },
    keyOf: (i) => String(edit.rowIds[i]?.[0] ?? i),
    lastAddedKey: () => lastKey(addedIn ? latest(addedIn) : undefined),
  };
}

/** New records are added at the end of their table. */
const lastKey = (t: TableDef | undefined) => (t && t.rows.length ? String(t.rows[t.rows.length - 1]._id) : null);
