import { useCallback, useMemo, useRef } from "react";
import type { TableDef } from "../../../shared/model";
import { useCommands, useWorkspace } from "../workspace/context";
import { exportCsv } from "../workspace/csv";
import { useTableEditing } from "../workspace/useTableEditing";
import { Datasheet, type DatasheetHandle } from "./Datasheet";

export function TableDatasheet({ table, tabKey }: { table: TableDef; tabKey: string }) {
  const ws = useWorkspace();
  const grid = useRef<DatasheetHandle>(null);
  const editing = useTableEditing(table);
  const fields = table.fields;

  const columns = useMemo(() => fields.map((f) => ({ key: f.id, label: f.name, field: f })), [fields]);
  const getValue = useCallback((r: number, c: number) => table.rows[r]?.[fields[c].id] ?? null, [table.rows, fields]);

  useCommands(tabKey, {
    newRecord: () => grid.current?.goToNewRecord(),
    deleteRecord: () => grid.current?.deleteSelected(),
    sortAsc: () => grid.current?.sort("ASC"),
    sortDesc: () => grid.current?.sort("DESC"),
    removeSort: () => grid.current?.sort(null),
    find: () => grid.current?.focusFind(),
    exportText: () =>
      exportCsv(
        table.name,
        fields.map((f) => f.name),
        table.rows.map((r) => fields.map((f) => r[f.id] ?? null)),
        fields,
      ),
  });

  if (!fields.length) {
    return <div className="empty-view">This table has no fields. Switch to Design View to add some.</div>;
  }

  return (
    <Datasheet
      ref={grid}
      columns={columns}
      rowCount={table.rows.length}
      getValue={getValue}
      rowKey={(r) => String(table.rows[r]._id ?? r)}
      editable
      onCommit={(row, col, input) => editing.commit(row, fields[col].id, input)}
      onDeleteRows={(rows) => void editing.deleteRows(rows)}
      newRowPlaceholder={(c) => (fields[c].type === "AutoNumber" ? "(New)" : "")}
      cellWarning={(r, c) => !!fields[c].required && (table.rows[r][fields[c].id] ?? "") === ""}
      onStatus={ws.setStatus}
    />
  );
}
