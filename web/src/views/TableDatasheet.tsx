import { useCallback, useEffect, useMemo, useRef } from "react";
import type { TableDef } from "../../../shared/model";
import { useCommands, useWorkspace, type RecordTarget } from "../workspace/context";
import { exportCsv } from "../workspace/csv";
import { useTableEditing } from "../workspace/useTableEditing";
import { Datasheet, type DatasheetHandle } from "./Datasheet";
import { useFieldLookups } from "./lookups";
import { useRowHeight } from "./useRowHeight";

export function TableDatasheet({ table, tabKey, goto }: { table: TableDef; tabKey: string; goto?: RecordTarget }) {
  const ws = useWorkspace();
  const grid = useRef<DatasheetHandle>(null);
  const editing = useTableEditing(table);
  const fields = table.fields;
  // Lookup fields show a name (e.g. the customer) instead of the stored key, with a drop-down.
  const lookups = useFieldLookups(ws.doc, fields);
  // Image fields show thumbnails; editors can drop, paste or choose pictures.
  const image = useMemo(() => ({ url: (id: string) => ws.imageUrl(id), ...(ws.readOnly ? {} : { upload: ws.uploadImage }) }), [ws.imageUrl, ws.uploadImage, ws.readOnly]); // eslint-disable-line react-hooks/exhaustive-deps
  const { rowHeight, saveRowHeight, askRowHeight } = useRowHeight(table.rowHeight, (h) =>
    ws.update((d) => {
      const t = d.tables.find((x) => x.id === table.id);
      if (!t) return;
      if (h === undefined) delete t.rowHeight;
      else t.rowHeight = h;
    }),
  );

  const columns = useMemo(
    () =>
      fields.map((f) => ({
        key: f.id,
        label: f.name,
        field: f,
        lookup: lookups[f.id],
        image: f.type === "Image" ? image : undefined,
        readOnlyReason: ws.readOnly ? "You have view-only access to this database." : undefined,
      })),
    [fields, ws.readOnly, lookups, image],
  );
  const getValue = useCallback((r: number, c: number) => table.rows[r]?.[fields[c].id] ?? null, [table.rows, fields]);

  // Opened at one record (a label's QR code): select it.
  useEffect(() => {
    if (!goto) return;
    const f = fields.find((x) => x.name.toLowerCase() === goto.field.toLowerCase());
    const i = f ? table.rows.findIndex((r) => String(r[f.id] ?? "") === goto.value) : -1;
    if (i < 0) return ws.setStatus(`There's no record with ${goto.field} ${goto.value} any more.`, "error");
    // After the grid has drawn.
    setTimeout(() => grid.current?.goToRow(i), 0);
  }, [goto?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  useCommands(tabKey, {
    newRecord: () => grid.current?.goToNewRecord(),
    deleteRecord: () => grid.current?.deleteSelected(),
    sortAsc: () => grid.current?.sort("ASC"),
    sortDesc: () => grid.current?.sort("DESC"),
    removeSort: () => grid.current?.sort(null),
    find: () => grid.current?.focusFind(),
    rowHeight: () => void askRowHeight(),
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
      editable={!ws.readOnly}
      onCommit={(row, col, input) => editing.commit(row, fields[col].id, input)}
      onDeleteRows={(rows) => void editing.deleteRows(rows)}
      newRowPlaceholder={(c) => (fields[c].type === "AutoNumber" ? "(New)" : "")}
      cellWarning={(r, c) => !!fields[c].required && (table.rows[r][fields[c].id] ?? "") === ""}
      onStatus={ws.setStatus}
      savedWidths={table.columnWidths}
      rowHeight={rowHeight}
      onRowHeightChange={saveRowHeight}
      onWidthsChange={(w) => {
        // Saved with the table, like Access's datasheet layout. Viewers just get it for this session.
        if (ws.readOnly) return;
        ws.update((d) => {
          const t = d.tables.find((x) => x.id === table.id);
          if (t) t.columnWidths = Object.fromEntries(Object.entries(w).filter(([id]) => t.fields.some((f) => f.id === id)));
        });
      }}
    />
  );
}
