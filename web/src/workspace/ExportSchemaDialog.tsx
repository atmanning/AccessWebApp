/** File → Export Schema: pick tables and a format, preview, then download or copy. */
import { useMemo, useState } from "react";
import type { ProjectDoc } from "../../../shared/model";
import { downloadBlob } from "../api";
import { exportSchema, SCHEMA_FORMAT_LABELS, SCHEMA_FORMATS, type SchemaFormat } from "../engine/schemaExport";
import { ComboBox } from "../ui/ComboBox";
import { Modal } from "../ui/dialogs";
import { TableIcon } from "../ui/icons";

const FORMAT_KEY = "accessweb.schemaFormat";
const safeName = (s: string) => s.replace(/[^\w\- ]+/g, "_").trim() || "Database";

export function ExportSchemaDialog(props: { doc: ProjectDoc; databaseName: string; onClose: () => void; onDone: (message: string) => void }) {
  const tables = props.doc.tables;
  const [picked, setPicked] = useState<Set<string>>(() => new Set(tables.map((t) => t.id)));
  const [format, setFormat] = useState<SchemaFormat>(() => {
    try {
      const f = localStorage.getItem(FORMAT_KEY) as SchemaFormat | null;
      return f && SCHEMA_FORMATS.includes(f) ? f : "mysql";
    } catch {
      return "mysql";
    }
  });
  const [copied, setCopied] = useState(false);
  // Keep the chosen tables in the database's order.
  const ids = tables.filter((t) => picked.has(t.id)).map((t) => t.id);
  const out = useMemo(() => (ids.length ? exportSchema(props.doc, ids, format, { databaseName: props.databaseName }) : null), [props.doc, ids.join(), format]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (f: SchemaFormat) => {
    setFormat(f);
    try {
      localStorage.setItem(FORMAT_KEY, f);
    } catch {
      /* remembered for this visit only */
    }
  };
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const fileName = `${safeName(props.databaseName)} schema${format === "markdown" ? "" : format === "json" ? "" : ` (${format})`}.${out?.extension ?? "sql"}`;

  return (
    <Modal
      title="Export Schema"
      onClose={props.onClose}
      width={760}
      footer={
        <>
          <button
            className="primary"
            disabled={!out}
            onClick={() => {
              downloadBlob(new Blob([out!.text], { type: `${out!.mime};charset=utf-8` }), fileName);
              props.onDone(`Exported the design of ${ids.length} table(s) as ${fileName}.`);
            }}
          >
            Download
          </button>
          <button
            disabled={!out}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(out!.text);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              } catch {
                /* the preview can be selected and copied by hand */
              }
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button onClick={props.onClose}>Close</button>
        </>
      }
    >
      <div className="schema-export">
        <div className="schema-side">
          <div className="schema-side-head">
            <strong>Tables</strong>
            <span>
              <button className="link" onClick={() => setPicked(new Set(tables.map((t) => t.id)))}>All</button>
              {" · "}
              <button className="link" onClick={() => setPicked(new Set())}>None</button>
            </span>
          </div>
          <div className="list-box schema-tables">
            {tables.map((t) => (
              <label key={t.id} className="list-item check-item">
                <input type="checkbox" checked={picked.has(t.id)} onChange={() => toggle(t.id)} />
                <TableIcon /> {t.name}
                <span className="muted small">{t.fields.length} fields</span>
              </label>
            ))}
            {!tables.length && <div className="muted pad">This database has no tables.</div>}
          </div>
          <label className="schema-format">
            Format
            <ComboBox className="text-input" value={format} ariaLabel="Format" options={SCHEMA_FORMATS.map((f) => ({ value: f, label: SCHEMA_FORMAT_LABELS[f] }))} onChange={choose} />
          </label>
          <p className="small muted">
            The design only: fields, data types, primary keys, indexes, defaults and relationships between the chosen tables (as foreign
            keys when they enforce integrity). No records are included.
          </p>
        </div>
        <textarea className="schema-preview" readOnly value={out?.text ?? "Choose at least one table."} aria-label="Preview" spellCheck={false} />
      </div>
    </Modal>
  );
}
