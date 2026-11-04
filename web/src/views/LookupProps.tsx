/**
 * Table Design → Field Properties → Lookup tab, and the Lookup Wizard, like Access: a field can
 * show a combo box that picks its value from another table or query (usually the key of a related
 * table, shown by a name) or from a typed list.
 */
import { useEffect, useMemo, useState } from "react";
import { LOOKUP_TYPES, type Field, type FieldLookup, type ProjectDoc, type TableDef } from "../../../shared/model";
import { ComboBox } from "../ui/ComboBox";
import { Modal } from "../ui/dialogs";
import { useWorkspace } from "../workspace/context";
import { sourceFieldNames } from "./sqlDesignReader";

const DISPLAY_OPTIONS = [
  { value: "text", label: "Text Box" },
  { value: "combo", label: "Combo Box" },
  { value: "list", label: "List Box" },
] as const;
const ROW_SOURCE_TYPE_OPTIONS = [
  { value: "table", label: "Table/Query" },
  { value: "values", label: "Value List" },
] as const;

export const LOOKUP_HELP: Record<string, string> = {
  display: "The type of control to display this field with on forms and in datasheets. Combo Box picks the value from a list.",
  rowSourceType: "Type of source for the control's data: a table or query, or a list of values you type.",
  rowSource: "The table or query the list comes from, or the values in the list separated by semicolons.",
  boundColumn: "The field of the row source whose value is stored in this field, usually the related table's key.",
  displayColumn: "The field of the row source that's shown in place of the stored value, such as a name.",
  limitToList: "Only allow values that are in the list.",
};

/** A source as one combo value: "table:<id>" or "query:<id>". */
const sourceKey = (l: Pick<FieldLookup, "rowSourceType" | "rowSource">) => (l.rowSourceType === "values" ? "" : `${l.rowSourceType}:${l.rowSource}`);

/** Field names of a table or query used as a row source (queries are run to find them). */
export function useSourceFields(doc: ProjectDoc, projectId: string, lookup?: Pick<FieldLookup, "rowSourceType" | "rowSource">): string[] {
  const [queryFields, setQueryFields] = useState<string[]>([]);
  const query = lookup?.rowSourceType === "query" ? doc.queries.find((q) => q.id === lookup.rowSource) : undefined;
  useEffect(() => {
    if (!query) return setQueryFields([]);
    let alive = true;
    sourceFieldNames(doc, projectId, query.name)?.then(
      (f) => alive && setQueryFields(f.map((x) => x.name)),
      () => alive && setQueryFields([]),
    );
    return () => {
      alive = false;
    };
  }, [query?.id, query?.sql]); // eslint-disable-line react-hooks/exhaustive-deps
  if (lookup?.rowSourceType === "table") return doc.tables.find((t) => t.id === lookup.rowSource)?.fields.map((f) => f.name) ?? [];
  return lookup?.rowSourceType === "query" ? queryFields : [];
}

/** A sensible lookup for a field: from its relationship to another table, if it has one. */
export function suggestLookup(doc: ProjectDoc, table: TableDef, field: Field): FieldLookup | null {
  const rel = doc.relationships.find((r) => r.toTable === table.id && r.toField === field.id && r.fromTable !== table.id);
  const parent = rel && doc.tables.find((t) => t.id === rel.fromTable);
  const key = parent?.fields.find((f) => f.id === rel!.fromField);
  if (!parent || !key) return null;
  return { display: "combo", rowSourceType: "table", rowSource: parent.id, boundColumn: key.name, displayColumn: defaultDisplay(parent, key.name) };
}

/** The field to show for a table: its first text field that isn't the key, else the key. */
export function defaultDisplay(t: TableDef, bound: string): string {
  return (t.fields.find((f) => f.name !== bound && f.type === "ShortText") ?? t.fields.find((f) => f.name !== bound) ?? { name: bound }).name;
}

export function LookupTab(props: {
  table: TableDef;
  field: Field;
  onChange: (lookup: FieldLookup | undefined) => void;
  onWizard: () => void;
  onHelp: (text: string) => void;
}) {
  const ws = useWorkspace();
  const { field } = props;
  const l = field.lookup;
  const fields = useSourceFields(ws.doc, ws.projectId, l);
  const sources = useMemo(
    () => [
      { value: "", label: "" },
      ...ws.doc.tables.map((t) => ({ value: `table:${t.id}`, label: t.name })),
      ...ws.doc.queries.map((q) => ({ value: `query:${q.id}`, label: `Query: ${q.name}` })),
    ],
    [ws.doc.tables, ws.doc.queries, props.table.id],
  );

  if (!LOOKUP_TYPES.includes(field.type)) {
    return (
      <tbody>
        <tr>
          <th>Display Control</th>
          <td>
            <span className="prop-static">{field.type === "YesNo" ? "Check Box" : "Text Box"}</span>
          </td>
        </tr>
        <tr>
          <td colSpan={2} className="prop-static small">
            Lookups are available for Short Text and Number fields. A field that stores another table's key is usually a Number.
          </td>
        </tr>
      </tbody>
    );
  }

  const set = (patch: Partial<FieldLookup>) => l && props.onChange({ ...l, ...patch });
  const row = (label: string, help: string, child: React.ReactNode) => (
    <tr onFocusCapture={() => props.onHelp(help)}>
      <th>{label}</th>
      <td>{child}</td>
    </tr>
  );
  const fieldOptions = [{ value: "", label: "" }, ...fields.map((f) => ({ value: f, label: f }))];

  return (
    <tbody>
      {row(
        "Display Control",
        LOOKUP_HELP.display,
        <ComboBox
          value={l ? l.display : "text"}
          ariaLabel="Display Control"
          options={[...DISPLAY_OPTIONS]}
          onChange={(v) => {
            if (v === "text") return props.onChange(undefined);
            if (l) return set({ display: v });
            // Start from the field's relationship when it has one; otherwise pick a source next.
            const suggested = suggestLookup(ws.doc, props.table, field);
            props.onChange(suggested ? { ...suggested, display: v } : { display: v, rowSourceType: "table", rowSource: "" });
          }}
        />,
      )}
      {l && (
        <>
          {row(
            "Row Source Type",
            LOOKUP_HELP.rowSourceType,
            <ComboBox
              value={l.rowSourceType === "values" ? "values" : "table"}
              ariaLabel="Row Source Type"
              options={[...ROW_SOURCE_TYPE_OPTIONS]}
              onChange={(v) => props.onChange(v === "values" ? { display: l.display, rowSourceType: "values", rowSource: "", limitToList: l.limitToList } : { display: l.display, rowSourceType: "table", rowSource: "", limitToList: l.limitToList })}
            />,
          )}
          {l.rowSourceType === "values"
            ? row(
                "Row Source",
                LOOKUP_HELP.rowSource,
                <input
                  defaultValue={l.rowSource}
                  key={`vals:${l.rowSource}`}
                  placeholder='e.g. "Red";"Green";"Blue"'
                  aria-label="Row Source"
                  maxLength={4000}
                  onBlur={(e) => e.target.value !== l.rowSource && set({ rowSource: e.target.value })}
                />,
              )
            : row(
                "Row Source",
                LOOKUP_HELP.rowSource,
                <ComboBox
                  value={sourceKey(l)}
                  ariaLabel="Row Source"
                  options={sources}
                  onChange={(v) => {
                    const [kind, id] = v.split(":") as ["table" | "query", string];
                    if (!v) return set({ rowSourceType: "table", rowSource: "", boundColumn: undefined, displayColumn: undefined });
                    const t = kind === "table" ? ws.doc.tables.find((x) => x.id === id) : undefined;
                    const key = t?.fields.find((f) => f.primaryKey)?.name ?? t?.fields[0]?.name;
                    props.onChange({
                      display: l.display,
                      rowSourceType: kind,
                      rowSource: id,
                      limitToList: l.limitToList,
                      ...(t && key ? { boundColumn: key, displayColumn: defaultDisplay(t, key) } : {}),
                    });
                  }}
                />,
              )}
          {l.rowSourceType !== "values" && (
            <>
              {row(
                "Bound Column",
                LOOKUP_HELP.boundColumn,
                <ComboBox value={l.boundColumn ?? ""} ariaLabel="Bound Column" options={fieldOptions} onChange={(v) => set({ boundColumn: v || undefined })} />,
              )}
              {row(
                "Display Column",
                LOOKUP_HELP.displayColumn,
                <ComboBox value={l.displayColumn ?? ""} ariaLabel="Display Column" options={fieldOptions} onChange={(v) => set({ displayColumn: v || undefined })} />,
              )}
            </>
          )}
          {row(
            "Limit To List",
            LOOKUP_HELP.limitToList,
            <ComboBox
              value={l.limitToList === false ? "No" : "Yes"}
              ariaLabel="Limit To List"
              options={[
                { value: "Yes", label: "Yes" },
                { value: "No", label: "No" },
              ]}
              onChange={(v) => set({ limitToList: v === "Yes" ? undefined : false })}
            />,
          )}
        </>
      )}
      <tr>
        <th />
        <td>
          <button className="lookup-wizard-btn" onClick={props.onWizard}>
            Lookup Wizard…
          </button>
        </td>
      </tr>
    </tbody>
  );
}

export interface WizardResult {
  lookup: FieldLookup;
  /** Make a relationship to the source table (Enable Data Integrity). */
  relate: boolean;
}

/** Access's Lookup Wizard, in one page: where the values come from, which field is stored, which is shown. */
export function LookupWizard(props: { table: TableDef; field: Field; onClose: () => void; onFinish: (r: WizardResult) => void }) {
  const ws = useWorkspace();
  const start = props.field.lookup ?? suggestLookup(ws.doc, props.table, props.field);
  const [mode, setMode] = useState<"source" | "values">(start?.rowSourceType === "values" ? "values" : "source");
  const firstOther = ws.doc.tables.find((t) => t.id !== props.table.id) ?? ws.doc.tables[0];
  const [source, setSource] = useState(start && start.rowSourceType !== "values" && start.rowSource ? sourceKey(start) : firstOther ? `table:${firstOther.id}` : "");
  const [kind, id] = source.split(":") as ["table" | "query", string];
  const fields = useSourceFields(ws.doc, ws.projectId, source ? { rowSourceType: kind, rowSource: id } : undefined);
  const table = kind === "table" ? ws.doc.tables.find((t) => t.id === id) : undefined;
  const key = table?.fields.find((f) => f.primaryKey)?.name ?? fields[0] ?? "";
  const [bound, setBound] = useState(start?.boundColumn ?? "");
  const [display, setDisplay] = useState(start?.displayColumn ?? "");
  const [values, setValues] = useState(start?.rowSourceType === "values" ? start.rowSource.split(";").map((v) => v.trim().replace(/^"(.*)"$/, "$1")).join("\n") : "");
  const [limit, setLimit] = useState(start?.limitToList !== false);
  const related = !!table && ws.doc.relationships.some((r) => r.toTable === props.table.id && r.toField === props.field.id && r.fromTable === table.id);
  const [relate, setRelate] = useState(!related);

  // Defaults follow the chosen source: store its key, show its first text field.
  const boundName = fields.includes(bound) ? bound : key;
  const displayName = fields.includes(display) ? display : table ? defaultDisplay(table, boundName) : (fields[1] ?? boundName);
  const sources = [
    ...ws.doc.tables.map((t) => ({ value: `table:${t.id}`, label: `Table: ${t.name}` })),
    ...ws.doc.queries.map((q) => ({ value: `query:${q.id}`, label: `Query: ${q.name}` })),
  ];
  const canFinish = mode === "values" ? values.trim().length > 0 : !!source && !!boundName;

  return (
    <Modal
      title="Lookup Wizard"
      onClose={props.onClose}
      width={520}
      footer={
        <>
          <button
            className="primary"
            disabled={!canFinish}
            onClick={() =>
              props.onFinish(
                mode === "values"
                  ? {
                      lookup: {
                        display: "combo",
                        rowSourceType: "values",
                        rowSource: values
                          .split("\n")
                          .map((v) => v.trim())
                          .filter(Boolean)
                          .map((v) => `"${v.replace(/"/g, "")}"`)
                          .join(";"),
                        ...(limit ? {} : { limitToList: false }),
                      },
                      relate: false,
                    }
                  : {
                      lookup: { display: "combo", rowSourceType: kind, rowSource: id, boundColumn: boundName, displayColumn: displayName, ...(limit ? {} : { limitToList: false }) },
                      relate: kind === "table" && relate && !related,
                    },
              )
            }
          >
            Finish
          </button>
          <button onClick={props.onClose}>Cancel</button>
        </>
      }
    >
      <div className="lookup-wizard">
        <p>
          The lookup field <strong>{props.field.name}</strong> shows a list of values to choose from. How do you want it to get its
          values?
        </p>
        <label className="lw-choice">
          <input type="radio" checked={mode === "source"} onChange={() => setMode("source")} />I want the lookup field to get the values from
          another table or query.
        </label>
        <label className="lw-choice">
          <input type="radio" checked={mode === "values"} onChange={() => setMode("values")} />I will type in the values that I want.
        </label>
        {mode === "source" ? (
          <div className="lw-grid">
            <span>Table or query</span>
            <ComboBox className="text-input" value={source} ariaLabel="Table or query" options={sources} onChange={(v) => (setSource(v), setBound(""), setDisplay(""))} />
            <span>Store the value of</span>
            <ComboBox className="text-input" value={boundName} ariaLabel="Stored field" options={fields.map((f) => ({ value: f, label: f }))} onChange={setBound} />
            <span>Show</span>
            <ComboBox className="text-input" value={displayName} ariaLabel="Shown field" options={fields.map((f) => ({ value: f, label: f }))} onChange={setDisplay} />
            <span />
            <div className="small muted">
              {props.field.name} stores {table ? `${table.name}'s` : "the"} <strong>{boundName || "…"}</strong>; datasheets and forms show{" "}
              <strong>{displayName || "…"}</strong> instead.
            </div>
            {kind === "table" && table?.id !== props.table.id && (
              <>
                <span />
                <label className="lw-check">
                  <input type="checkbox" checked={related || relate} disabled={related} onChange={(e) => setRelate(e.target.checked)} />
                  {related ? "Related to this table already" : "Enable data integrity (create a relationship)"}
                </label>
              </>
            )}
          </div>
        ) : (
          <textarea className="lw-values" rows={6} value={values} onChange={(e) => setValues(e.target.value)} placeholder={"One value per line, e.g.\nRed\nGreen\nBlue"} aria-label="Values" />
        )}
        <label className="lw-check">
          <input type="checkbox" checked={limit} onChange={(e) => setLimit(e.target.checked)} />
          Limit to list (only values from the list can be entered)
        </label>
      </div>
    </Modal>
  );
}
