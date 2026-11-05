/** Create → Labels: pick the people (a table or query), the label product, and whether to add QR codes. */
import { useState } from "react";
import type { ProjectDoc, SourceRef } from "../../../shared/model";
import { ComboBox } from "../ui/ComboBox";
import { Modal } from "../ui/dialogs";
import { LABEL_PRESETS } from "./labels";

export function NewLabelsDialog(props: { doc: ProjectDoc; initial?: SourceRef | null; onClose: () => void; onCreate: (source: SourceRef, preset: string, qr: boolean) => void }) {
  const sources = [
    ...props.doc.tables.map((t) => ({ value: `table:${t.id}`, label: `Table: ${t.name}` })),
    ...props.doc.queries.map((q) => ({ value: `query:${q.id}`, label: `Query: ${q.name}` })),
  ];
  const [source, setSource] = useState(props.initial ? `${props.initial.kind}:${props.initial.id}` : (sources[0]?.value ?? ""));
  const [preset, setPreset] = useState("avery-5395");
  const [qr, setQr] = useState(true);
  return (
    <Modal
      title="Labels"
      onClose={props.onClose}
      width={520}
      footer={
        <>
          <button
            className="primary"
            disabled={!source}
            onClick={() => {
              const [kind, id] = source.split(":");
              props.onCreate({ kind: kind as SourceRef["kind"], id }, preset, qr);
            }}
          >
            Create
          </button>
          <button onClick={props.onClose}>Cancel</button>
        </>
      }
    >
      <div className="new-labels">
        <p>Print a label or name tag for every record, on sheets of labels.</p>
        <label>
          Records from
          <ComboBox className="text-input" value={source} ariaLabel="Records from" options={sources} onChange={setSource} />
        </label>
        <label>
          Label product
          <ComboBox className="text-input" value={preset} ariaLabel="Label product" options={LABEL_PRESETS.map((p) => ({ value: p.id, label: p.name }))} onChange={setPreset} />
        </label>
        <label className="ls-check">
          <input type="checkbox" checked={qr} onChange={(e) => setQr(e.target.checked)} />
          Add a QR code that opens each person's record when scanned
        </label>
        <p className="small muted">You can change the size, margins, text and QR code afterwards in Design View, with a live preview.</p>
      </div>
    </Modal>
  );
}
