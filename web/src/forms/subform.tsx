/**
 * Subforms (FileMaker's portals): another table's records that belong to the form's record, e.g. a
 * customer's orders, shown as a datasheet inside the form. Link Master Fields / Link Child Fields
 * say which records belong (Orders.CustomerID = this customer's CustomerID); new rows typed into
 * the subform get the link filled in for them.
 */
import { useCallback, useMemo } from "react";
import type { CellValue, FormControl, FormDef, ProjectDoc, TableDef } from "../../../shared/model";
import { Datasheet } from "../views/Datasheet";
import { useFieldLookups } from "../views/lookups";
import { useWorkspace } from "../workspace/context";
import { useRecordEditing } from "../workspace/useTableEditing";

export interface SubformLink {
  table: TableDef;
  /** Field of the form's record. */
  master: string;
  /** Field of the subform's table that holds the master's value. */
  child: string;
}

/** Tables related to the form's table, with the fields that link them (one-to-many first). */
export function relatedTables(doc: ProjectDoc, form: Pick<FormDef, "source">): SubformLink[] {
  if (form.source.kind !== "table") return [];
  const me = doc.tables.find((t) => t.id === form.source.id);
  if (!me) return [];
  const out: SubformLink[] = [];
  const name = (t: TableDef | undefined, id: string) => t?.fields.find((f) => f.id === id)?.name;
  for (const r of doc.relationships) {
    if (r.fromTable === me.id && r.toTable !== me.id) {
      const child = doc.tables.find((t) => t.id === r.toTable);
      const m = name(me, r.fromField);
      const c = name(child, r.toField);
      if (child && m && c) out.push({ table: child, master: m, child: c });
    }
  }
  return out;
}

/** The link fields for showing `tableId` in a form on `form`'s table, from a relationship either way. */
export function suggestLink(doc: ProjectDoc, form: Pick<FormDef, "source">, tableId: string): { master: string; child: string } | null {
  const hit = relatedTables(doc, form).find((r) => r.table.id === tableId);
  if (hit) return { master: hit.master, child: hit.child };
  if (form.source.kind !== "table") return null;
  // The other way round (an order form showing its customer).
  const me = doc.tables.find((t) => t.id === form.source.id);
  const other = doc.tables.find((t) => t.id === tableId);
  const r = doc.relationships.find((x) => x.toTable === form.source.id && x.fromTable === tableId);
  const m = r && me?.fields.find((f) => f.id === r.toField)?.name;
  const c = r && other?.fields.find((f) => f.id === r.fromField)?.name;
  return m && c ? { master: m, child: c } : null;
}

const sameKey = (a: CellValue | undefined, b: CellValue | undefined) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

/** A subform in Form View: the related records of the form's current record. */
export function SubformView(props: {
  c: FormControl;
  /** The form's current record's value of Link Master Fields; undefined on a new, unsaved record. */
  master: CellValue | undefined;
  /** The form's record is new and not saved yet. */
  newRecord: boolean;
  /** Link Master Fields isn't a field of the form's record source. */
  masterMissing?: boolean;
  readOnly?: boolean;
}) {
  const { c } = props;
  const ws = useWorkspace();
  const { commitTo, deleteFrom } = useRecordEditing();
  const table = ws.doc.tables.find((t) => t.id === c.sourceObject);
  const linked = !!(c.linkMaster && c.linkChild);
  const childField = linked ? table?.fields.find((f) => f.name.toLowerCase() === c.linkChild!.toLowerCase()) : undefined;
  const fields = useMemo(() => (table ? table.fields.filter((f) => f !== childField) : []), [table, childField]);
  const lookups = useFieldLookups(ws.doc, fields);
  const image = useMemo(() => ({ url: (id: string) => ws.imageUrl(id), ...(ws.readOnly ? {} : { upload: ws.uploadImage }) }), [ws.imageUrl, ws.uploadImage, ws.readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // The table's rows that belong to this record (by index into table.rows).
  const rows = useMemo(() => {
    if (!table) return [];
    const all = table.rows.map((_, i) => i);
    if (!linked) return all;
    if (!childField || props.master === undefined) return [];
    return all.filter((i) => sameKey(table.rows[i][childField.id], props.master));
  }, [table, linked, childField, props.master]);

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
    [fields, lookups, image, ws.readOnly],
  );
  const getValue = useCallback((r: number, col: number) => (table ? table.rows[rows[r]]?.[fields[col].id] ?? null : null), [table, rows, fields]);

  const problem = !c.sourceObject
    ? "Choose the table this subform shows: Source Object in the Property Sheet."
    : !table
      ? "The table this subform showed was deleted. Choose another in the Property Sheet."
      : linked && !childField
        ? `${table.name} has no field named ${c.linkChild}. Check Link Child Fields in the Property Sheet.`
        : props.masterMissing
          ? `The form's records have no field named ${c.linkMaster}. Check Link Master Fields in the Property Sheet.`
          : null;
  if (problem) return <div className="sf-box sf-message">{problem}</div>;

  if (linked && props.newRecord) {
    return <div className="sf-box sf-message">Fill in this record first. Then you can add {table!.name} for it here.</div>;
  }
  const canAdd = !props.readOnly && !ws.readOnly && (!linked || (props.master !== null && props.master !== undefined && props.master !== ""));

  return (
    <div className="sf-box">
      <Datasheet
        // A new record in the form starts a fresh grid.
        key={String(props.master ?? "")}
        columns={columns}
        rowCount={rows.length}
        getValue={getValue}
        rowKey={(r) => String(table!.rows[rows[r]]?._id ?? r)}
        editable={!props.readOnly && !ws.readOnly}
        allowNew={canAdd}
        autoFocus={false}
        onCommit={(row, col, input) =>
          row === "new"
            ? commitTo(table!, "new", fields[col].id, input, childField ? { [childField.id]: props.master ?? null } : undefined)
            : commitTo(table!, rows[row], fields[col].id, input)
        }
        onDeleteRows={(rs) => void deleteFrom(table!, rs.map((r) => rows[r]))}
        newRowPlaceholder={(col) => (fields[col].type === "AutoNumber" ? "(New)" : "")}
        cellWarning={(r, col) => !!fields[col].required && (table!.rows[rows[r]]?.[fields[col].id] ?? "") === ""}
        onStatus={ws.setStatus}
        savedWidths={table!.columnWidths}
        emptyMessage={canAdd ? undefined : "No related records."}
      />
    </div>
  );
}

/** A subform in Design View: its table's columns, like Access shows the subform's layout. */
export function SubformDesign({ c }: { c: FormControl }) {
  const ws = useWorkspace();
  const table = ws.doc.tables.find((t) => t.id === c.sourceObject);
  if (!table) return <div className="sf-box sf-message">Subform: choose its table (Source Object) in the Property Sheet.</div>;
  const cols = table.fields.filter((f) => !(c.linkChild && f.name.toLowerCase() === c.linkChild.toLowerCase()));
  return (
    <div className="sf-box sf-design">
      <div className="sf-design-head">
        {cols.map((f) => (
          <span key={f.id}>{f.name}</span>
        ))}
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="sf-design-row">
          {cols.map((f) => (
            <span key={f.id} />
          ))}
        </div>
      ))}
      <div className="sf-design-foot">
        {table.name}
        {c.linkMaster && c.linkChild ? ` · ${c.linkChild} = [${c.linkMaster}]` : " · all records (not linked)"}
      </div>
    </div>
  );
}
