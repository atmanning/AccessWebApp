/** Creating or changing a scan action: whose tags, and what each scan records. */
import { useState } from "react";
import type { ScanAction, TableDef } from "../../../shared/model";
import { Modal } from "../ui/dialogs";
import { useWorkspace } from "../workspace/context";
import { newId } from "../workspace/docOps";
import { keyField, makeLogTable } from "./scanActions";

export function ScanActionEditor(props: { action: ScanAction | null; onClose: () => void; onSaved: (id: string) => void; onDeleted: () => void }) {
  const ws = useWorkspace();
  const doc = ws.doc;
  // People tables: ones with a one-field primary key; labels reports' tables first.
  const labelTables = new Set(doc.reports.filter((r) => r.labels && r.source.kind === "table").map((r) => r.source.id));
  const peopleTables = doc.tables.filter((t) => keyField(t)).sort((a, b) => Number(labelTables.has(b.id)) - Number(labelTables.has(a.id)));
  const [a, setA] = useState<ScanAction>(
    () =>
      props.action ?? {
        id: newId("scan"),
        name: "",
        people: peopleTables[0]?.id ?? "",
        kind: "add",
        once: true,
      },
  );
  const [error, setError] = useState<string | null>(null);
  const [who, setWho] = useState("");
  const set = (patch: Partial<ScanAction>) => {
    setA((x) => ({ ...x, ...patch }));
    setError(null);
  };
  const people = doc.tables.find((t) => t.id === a.people);
  const logTable = doc.tables.find((t) => t.id === a.table);
  const others = doc.tables.filter((t) => t.id !== a.people);

  /** When the log table changes: guess the person and time fields. */
  const pickTable = (t: TableDef | undefined) => {
    if (!t || !people) return set({ table: t?.id });
    const pk = keyField(people);
    const rel = doc.relationships.find((r) => r.fromTable === people.id && r.toTable === t.id);
    const personField = rel?.toField ?? t.fields.find((f) => f.name.toLowerCase() === pk?.name.toLowerCase())?.id;
    const timeField = t.fields.find((f) => f.type === "DateTime")?.id;
    set({ table: t.id, personField, timeField, values: {} });
  };

  const makeTable = () => {
    if (!people) return;
    const base = a.name.toLowerCase().includes("achiev") ? "Achievements" : "Attendance";
    let name = base;
    for (let i = 2; doc.tables.some((t) => t.name.toLowerCase() === name.toLowerCase()); i++) name = `${base}${i}`;
    let made: ReturnType<typeof makeLogTable> | null = null;
    ws.update((d) => {
      made = makeLogTable(d, d.tables.find((t) => t.id === people.id)!, name, base === "Achievements" ? "Achievement" : "Event");
    });
    if (made) {
      const m = made as ReturnType<typeof makeLogTable>;
      set({ ...m.action });
      ws.setStatus(`Made the table ${name}, related to ${people.name}. Each scan adds a record to it.`);
    }
  };

  const save = () => {
    if (!a.name.trim()) return setError('Give it a name people will recognise, like "Attended: Session 2" or "Achievement: CPR".');
    if (!people) return setError("Choose whose name tags are scanned.");
    if (a.kind === "add" && (!logTable || !a.personField)) return setError("Choose the table each scan adds a record to, and its field that stores the person.");
    if (a.kind === "set" && !a.field) return setError("Choose the field each scan changes.");
    const clean: ScanAction = { ...a, name: a.name.trim() };
    if (clean.kind === "add") {
      delete clean.field;
      delete clean.value;
    } else {
      delete clean.table;
      delete clean.personField;
      delete clean.timeField;
      delete clean.values;
    }
    ws.update((d) => {
      const list = (d.scanActions ??= []);
      const i = list.findIndex((x) => x.id === clean.id);
      if (i >= 0) list[i] = clean;
      else list.push(clean);
    });
    props.onSaved(clean.id);
  };

  return (
    <Modal
      title={props.action ? "Edit Scan Action" : "New Scan Action"}
      onClose={props.onClose}
      width={560}
      footer={
        <>
          {props.action && (
            <button
              className="danger"
              onClick={() => {
                ws.update((d) => {
                  d.scanActions = (d.scanActions ?? []).filter((x) => x.id !== a.id);
                  if (!d.scanActions.length) delete d.scanActions;
                });
                props.onDeleted();
              }}
            >
              Delete
            </button>
          )}
          <span className="spacer" />
          <button className="primary" onClick={save}>
            Save
          </button>
          <button onClick={props.onClose}>Cancel</button>
        </>
      }
    >
      <div className="sae">
        <label className="sae-row">
          <span>Name</span>
          <input autoFocus value={a.name} maxLength={100} placeholder="e.g. Attended: Session 2" onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="sae-row">
          <span>Whose name tags</span>
          <select value={a.people} onChange={(e) => set({ people: e.target.value, table: undefined, personField: undefined, field: undefined })}>
            {!peopleTables.length && <option value="">(no table has a primary key)</option>}
            {peopleTables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="sae-kind">
          <legend>Each scan…</legend>
          <label>
            <input type="radio" checked={a.kind === "add"} onChange={() => set({ kind: "add" })} /> <strong>adds a record</strong> to a table{" "}
            <span className="muted">(an attendance log, achievements earned: keeps every scan with its time)</span>
          </label>
          <label>
            <input type="radio" checked={a.kind === "set"} onChange={() => set({ kind: "set" })} /> <strong>changes a field</strong> on the person{" "}
            <span className="muted">(e.g. ticks Checked In, or fills in a date)</span>
          </label>
        </fieldset>

        {a.kind === "add" ? (
          <>
            <div className="sae-row">
              <span>Table</span>
              <div className="sae-inline">
                <select value={a.table ?? ""} onChange={(e) => pickTable(doc.tables.find((t) => t.id === e.target.value))}>
                  <option value="">(choose a table)</option>
                  {others.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <button type="button" disabled={!people || ws.readOnly} onClick={makeTable} title="Make a table for the log, related to the people table">
                  Make one for me
                </button>
              </div>
            </div>
            {logTable && (
              <>
                <label className="sae-row">
                  <span>Field for the person</span>
                  <select value={a.personField ?? ""} onChange={(e) => set({ personField: e.target.value || undefined })}>
                    <option value="">(choose)</option>
                    {logTable.fields
                      .filter((f) => f.type !== "AutoNumber")
                      .map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="sae-row">
                  <span>Time of the scan in</span>
                  <select value={a.timeField ?? ""} onChange={(e) => set({ timeField: e.target.value || undefined })}>
                    <option value="">(don't record the time)</option>
                    {logTable.fields
                      .filter((f) => f.type === "DateTime")
                      .map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                  </select>
                </label>
                {logTable.fields
                  .filter((f) => f.id !== a.personField && f.id !== a.timeField && f.type !== "AutoNumber" && f.type !== "Image")
                  .map((f) => (
                    <label key={f.id} className="sae-row">
                      <span>{f.name}</span>
                      <input
                        value={a.values?.[f.id] ?? ""}
                        placeholder={f.type === "YesNo" ? "Yes or No" : f.type === "DateTime" ? "a date, or Now" : "(leave empty)"}
                        onChange={(e) => set({ values: { ...a.values, [f.id]: e.target.value } })}
                      />
                    </label>
                  ))}
              </>
            )}
          </>
        ) : (
          people && (
            <>
              <label className="sae-row">
                <span>Field</span>
                <select value={a.field ?? ""} onChange={(e) => set({ field: e.target.value || undefined, value: people.fields.find((f) => f.id === e.target.value)?.type === "DateTime" ? "Now" : "Yes" })}>
                  <option value="">(choose a field of {people.name})</option>
                  {people.fields
                    .filter((f) => !f.primaryKey && f.type !== "AutoNumber" && f.type !== "Image")
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="sae-row">
                <span>Set it to</span>
                <input value={a.value ?? ""} placeholder="Yes, a word, or Now (the time of the scan)" onChange={(e) => set({ value: e.target.value })} />
              </label>
              {!people.fields.some((f) => !f.primaryKey && f.type === "YesNo") && (
                <p className="small muted">Tip: add a Yes/No field to {people.name} in Table Design (e.g. "CPR Certified") for each achievement you want to tick.</p>
              )}
            </>
          )
        )}

        <div className="sae-who">
          <div className="sae-who-title">Who can record</div>
          <p className="small muted">
            You and anyone who can edit this database, always. Add other people (they need an Access Web account) to let them record from a name tag's public page: they
            scan the tag with their phone, sign in, and tick <strong>{a.name || "this action"}</strong>. They can't see or change anything else.
          </p>
          <div className="sae-chips">
            {(a.recorders ?? []).map((e) => (
              <span key={e} className="ix-chip">
                {e}
                <button aria-label={`Remove ${e}`} onClick={() => set({ recorders: (a.recorders ?? []).filter((x) => x !== e) })}>
                  ×
                </button>
              </span>
            ))}
          </div>
          <form
            className="sae-inline"
            onSubmit={(e) => {
              e.preventDefault();
              const email = who.trim().toLowerCase();
              if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setError("Please type a whole email address, like taker@example.com.");
              if (!(a.recorders ?? []).includes(email)) set({ recorders: [...(a.recorders ?? []), email] });
              setWho("");
            }}
          >
            <input type="email" value={who} onChange={(e) => setWho(e.target.value)} placeholder="Email of someone who takes attendance" aria-label="Add a person who can record" />
            <button type="submit" disabled={!who.trim()}>
              Add
            </button>
          </form>
        </div>

        <label className="sae-check">
          <input type="checkbox" checked={!!a.once} onChange={(e) => set({ once: e.target.checked })} /> Only once per person{" "}
          <span className="muted">{a.kind === "add" ? "(with these same values)" : ""}: a second scan shows "Already recorded"</span>
        </label>
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
