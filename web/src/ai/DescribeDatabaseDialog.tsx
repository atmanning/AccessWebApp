/**
 * Describe a database in plain words; the AI assistant designs its tables, relationships, a few
 * queries and reports (with made-up sample records if you like), and you see the design before
 * anything is made. Used from the home screen (a new database) and Create > Describe Tables (adds to
 * this one).
 */
import { useEffect, useState } from "react";
import { FIELD_TYPE_LABELS } from "../../../shared/model";
import type { AiDatabaseSpec } from "../../../shared/ai";
import { api } from "../api";
import { Modal } from "../ui/dialogs";

const EXAMPLES = [
  "Track our volunteers, the events they sign up for, and the hours they work",
  "A lending library: members, books, and who has borrowed what and when it's due",
  "Equipment inspections: each piece of equipment, inspection dates, who inspected it, pass or fail, and notes",
];

export function DescribeDatabaseDialog(props: {
  /** "new": a new database; "add": tables added to this one (its design goes along so they fit in). */
  mode: "new" | "add";
  schema?: string;
  onClose: () => void;
  /** Makes it; the dialog closes when this resolves. */
  onCreate: (design: AiDatabaseSpec, opts: { sampleData: boolean; name: string }) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState("");
  const [sampleData, setSampleData] = useState(props.mode === "new");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [design, setDesign] = useState<AiDatabaseSpec | null>(null);
  const [designedWithSamples, setDesignedWithSamples] = useState(false);
  const [history, setHistory] = useState<{ prompt: string; design?: string }[]>([]);
  const [name, setName] = useState("");
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    api.aiStatus().then((s) => {
      if (!s.available) setError(s.reason ?? "The AI assistant isn't available.");
      if (s.remaining !== undefined) setRemaining(s.remaining);
    }, () => undefined);
  }, []);

  const ask = async (text = prompt.trim()) => {
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.aiDatabase({ prompt: text, schema: props.schema, sampleData, history });
      setRemaining(r.remaining);
      setDesign(r.design);
      setDesignedWithSamples(sampleData);
      if (!design || !name) setName(r.design.name);
      // The design goes back with a change, without its sample records (they're made again).
      const lean = { ...r.design, tables: r.design.tables.map(({ sampleRows: _s, ...t }) => t) };
      setHistory([...history, { prompt: text, design: JSON.stringify(lean).slice(0, 80_000) }].slice(-4));
      setPrompt("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!design) return;
    setBusy(true);
    try {
      await props.onCreate(design, { sampleData: sampleData && designedWithSamples, name: name.trim() || design.name });
      props.onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const records = design?.tables.reduce((n, t) => n + (t.sampleRows?.length ?? 0), 0) ?? 0;
  return (
    <Modal
      title={props.mode === "new" ? "Describe a Database" : "Describe Tables"}
      onClose={props.onClose}
      width={880}
      footer={
        <>
          {design && (
            <button className="primary" onClick={create} disabled={busy}>
              {props.mode === "new" ? "Create Database" : "Add to This Database"}
            </button>
          )}
          <button onClick={props.onClose}>Cancel</button>
        </>
      }
    >
      <div className="ai-dialog">
        <label className="ai-label" htmlFor="ai-db-prompt">
          {design ? "Want changes? Say what to change:" : props.mode === "new" ? "What do you want to keep track of?" : "What do you want to add to this database?"}
        </label>
        <div className="ai-ask">
          <textarea
            id="ai-db-prompt"
            className="text-input"
            rows={design ? 2 : 4}
            value={prompt}
            autoFocus
            placeholder={design ? "e.g. add a phone number to volunteers, and a table of donations" : "e.g. our volunteers, the events they sign up for, and the hours they work"}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                ask();
              }
            }}
          />
          <button className="primary" onClick={() => ask()} disabled={busy || !prompt.trim()}>
            {busy ? "Designing…" : design ? "Change" : "Design It"}
          </button>
        </div>
        <label className="check-label ai-check">
          <input type="checkbox" checked={sampleData} onChange={(e) => setSampleData(e.target.checked)} /> Fill in made-up sample records, to try it out
        </label>
        {design && sampleData && !designedWithSamples && <div className="small muted">Click Change (or Design It again) to get sample records with the design.</div>}
        {!design && (
          <div className="ai-examples">
            {EXAMPLES.map((x) => (
              <button key={x} type="button" onClick={() => setPrompt(x)}>
                {x}
              </button>
            ))}
          </div>
        )}
        {error && <div className="ai-error" role="alert">{error}</div>}
        {busy && !design && <div className="small muted">Designing tables and relationships… this takes up to a minute.</div>}
        {design && (
          <div className="ai-result">
            <div className="ai-explain">{design.summary}</div>
            {props.mode === "new" && (
              <label className="ai-name">
                Database name <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
            )}
            <div className="ai-tables">
              {design.tables.map((t) => (
                <div key={t.name} className="ai-table">
                  <div className="ai-table-name">
                    {t.name}
                    {designedWithSamples && t.sampleRows?.length ? <span className="muted"> · {t.sampleRows.length} records</span> : null}
                  </div>
                  {t.description && <div className="small muted">{t.description}</div>}
                  <ul>
                    {t.fields.map((f) => (
                      <li key={f.name}>
                        <span className={f.type === "AutoNumber" ? "ai-key" : ""}>{f.name}</span>
                        <span className="muted">
                          {" "}
                          {f.references ? `→ ${f.references}` : f.choices?.length ? `list: ${f.choices.slice(0, 4).join(", ")}${f.choices.length > 4 ? "…" : ""}` : FIELD_TYPE_LABELS[f.type]}
                          {f.required ? " · required" : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {(design.queries?.length || design.reports?.length) && (
              <div className="ai-extras small">
                {design.queries?.length ? <div><strong>Queries:</strong> {design.queries.map((q) => q.name).join(", ")}</div> : null}
                {design.reports?.length ? <div><strong>Reports:</strong> {design.reports.map((r) => r.name).join(", ")}</div> : null}
                <div className="muted">Plus a form for each table{records ? ` and ${records} sample records` : ""}.</div>
              </div>
            )}
          </div>
        )}
        <p className="small muted ai-privacy">
          Your description{props.mode === "add" ? " and this database's design go" : " goes"} to Claude, Anthropic's AI, to design the tables. Everything it makes can be changed in Design View.
          {remaining !== null && ` ${remaining} AI request${remaining === 1 ? "" : "s"} left today.`}
        </p>
      </div>
    </Modal>
  );
}
