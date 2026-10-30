import { useState } from "react";
import { FIELD_TYPE_LABELS, FIELD_TYPES, defaultFieldProps, type Field, type FieldType, type Row } from "../../../shared/model";
import { parseInput } from "../engine/values";
import { Modal } from "../ui/dialogs";
import { useWorkspace } from "./context";
import { inferType, parseCsv } from "./csv";
import { newId, uniqueObjectName, validateObjectName } from "./docOps";

export function ImportCsvDialog({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const [rows, setRows] = useState<string[][] | null>(null);
  const [fileName, setFileName] = useState("");
  const [hasHeader, setHasHeader] = useState(true);
  const [tableName, setTableName] = useState("");
  const [types, setTypes] = useState<FieldType[]>([]);
  const [addId, setAddId] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const header = rows ? (hasHeader ? rows[0] : rows[0].map((_, i) => `Field${i + 1}`)) : [];
  const body = rows ? (hasHeader ? rows.slice(1) : rows) : [];
  const names = header.map((h, i) => {
    const clean = h.replace(/[.!`[\]]/g, "_").trim().slice(0, 64) || `Field${i + 1}`;
    return header.slice(0, i).some((x) => x.trim().toLowerCase() === h.trim().toLowerCase()) ? `${clean}_${i + 1}` : clean;
  });

  const load = async (file: File) => {
    setError(null);
    if (file.size > 20 * 1024 * 1024) return setError("That file is larger than 20 MB.");
    const parsed = parseCsv(await file.text());
    if (!parsed.length) return setError("The file is empty.");
    const width = Math.max(...parsed.map((r) => r.length));
    const normalized = parsed.map((r) => [...r, ...Array(width - r.length).fill("")]);
    setRows(normalized);
    setFileName(file.name);
    const base = file.name.replace(/\.[^.]+$/, "").replace(/[.!`[\]]/g, "_").slice(0, 60) || "Imported";
    setTableName(uniqueObjectName(ws.doc, "table", base));
    const data = hasHeader ? normalized.slice(1) : normalized;
    setTypes(normalized[0].map((_, c) => inferType(data.map((r) => r[c]))));
  };

  const doImport = () => {
    if (!rows) return;
    const err = validateObjectName(ws.doc, "table", tableName);
    if (err) return setError(err);
    if (addId && names.some((n) => n.toLowerCase() === "id")) return setError("The file already has a column named ID. Untick 'Add an ID primary key'.");
    const fields: Field[] = names.map((name, i) => {
      // Text longer than Short Text allows becomes Long Text rather than being truncated.
      const type = types[i] === "ShortText" && body.some((r) => (r[i] ?? "").length > 255) ? "LongText" : types[i];
      return { id: newId("f"), name, type, ...defaultFieldProps(type) };
    });
    const idFieldId = addId ? newId("f") : null;
    let skipped = 0;
    const tableRows: Row[] = body.map((r, ri) => {
      const row: Row = { _id: newId("r") };
      if (idFieldId) row[idFieldId] = ri + 1;
      fields.forEach((f, i) => {
        const p = parseInput(f, r[i] ?? "");
        if (!p.ok) skipped++;
        row[f.id] = p.ok ? p.value : null;
      });
      return row;
    });
    const allFields: Field[] = idFieldId ? [{ id: idFieldId, name: "ID", type: "AutoNumber", primaryKey: true }, ...fields] : fields;
    const id = newId("t");
    ws.update((d) => {
      d.tables.push({ id, name: tableName.trim(), fields: allFields, rows: tableRows, nextAutoNumber: tableRows.length + 1 });
    });
    ws.openObject("table", id);
    ws.setStatus(`Imported ${tableRows.length} record(s) into ${tableName.trim()}${skipped ? `; ${skipped} value(s) couldn't be converted and were left blank` : ""}.`);
    onClose();
  };

  return (
    <Modal
      title="Get External Data - Text File"
      onClose={onClose}
      width={720}
      footer={
        <>
          <button className="primary" disabled={!rows} onClick={doImport}>Import</button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <p>Import a comma, tab or semicolon separated text file (.csv, .txt) into a new table.</p>
      <input type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} aria-label="Choose file" />
      {rows && (
        <>
          <div className="import-options">
            <label>
              Table name <input className="text-input" value={tableName} onChange={(e) => setTableName(e.target.value)} />
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={hasHeader}
                onChange={(e) => {
                  setHasHeader(e.target.checked);
                  const data = e.target.checked ? rows.slice(1) : rows;
                  setTypes(rows[0].map((_, c) => inferType(data.map((r) => r[c]))));
                }}
              />
              First row contains field names
            </label>
            <label className="check-label">
              <input type="checkbox" checked={addId} onChange={(e) => setAddId(e.target.checked)} /> Add an ID primary key
            </label>
          </div>
          <div className="import-preview">
            <table className="datasheet">
              <thead>
                <tr>
                  {names.map((n, i) => (
                    <th key={i}>
                      <div>{n}</div>
                      <select value={types[i]} onChange={(e) => setTypes(types.map((t, j) => (j === i ? (e.target.value as FieldType) : t)))} aria-label={`Type for ${n}`}>
                        {FIELD_TYPES.filter((t) => t !== "AutoNumber").map((t) => (
                          <option key={t} value={t}>{FIELD_TYPE_LABELS[t]}</option>
                        ))}
                      </select>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.slice(0, 8).map((r, ri) => (
                  <tr key={ri}>
                    {r.map((v, ci) => <td key={ci}>{v}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="small muted">{fileName}: {body.length} record(s). Showing the first {Math.min(8, body.length)}.</div>
        </>
      )}
      {error && <div className="field-error">{error}</div>}
    </Modal>
  );
}
