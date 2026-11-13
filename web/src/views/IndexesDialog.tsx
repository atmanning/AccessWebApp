/**
 * Indexes, like Access's Indexes window but simpler: each index is a name, the fields it covers
 * (in order) and whether their combination must be unique, e.g. "PetBreed: PetType + Breed, Unique".
 * The primary key is shown too (set with the Primary Key button). An index on a single field is the
 * same as that field's Indexed property, so it's saved there.
 */
import { useState } from "react";
import type { Field, TableDef, TableIndex } from "../../../shared/model";
import { firstDuplicate } from "../engine/combos";
import { Modal } from "../ui/dialogs";
import { newId } from "../workspace/docOps";

function validateName(n: string): string | null {
  if (!n.trim()) return "please give it a name.";
  if (/[.![\]`]/.test(n)) return "names can't contain . ! ` [ or ].";
  return null;
}

type Draft = { id: string; name: string; fields: string[]; unique: boolean };

export function IndexesDialog(props: {
  table: TableDef;
  /** Field ids selected in the design grid, offered for a new index. */
  selected: string[];
  onOk: (indexes: TableIndex[], singleField: { fieldId: string; unique: boolean }[]) => void;
  onClose: () => void;
}) {
  const { table } = props;
  const named = (id: string) => table.fields.find((f) => f.id === id);
  const usable = table.fields.filter((f) => f.type !== "Image" && f.type !== "LongText");
  const [list, setList] = useState<Draft[]>(() => {
    const start = (table.indexes ?? []).map((ix) => ({ ...ix, fields: [...ix.fields] }));
    // Two or more rows selected in the grid: start a unique index on them.
    const sel = props.selected.filter((id) => usable.some((f) => f.id === id));
    if (sel.length > 1 && !start.some((ix) => ix.fields.join() === sel.join())) {
      start.push({ id: newId("ix"), name: uniqueName(start, sel.map((id) => named(id)!.name).join("")), fields: sel, unique: true });
    }
    return start;
  });
  const [error, setError] = useState<string | null>(null);
  const pk = table.fields.filter((f) => f.primaryKey);
  const singles = table.fields.filter((f) => f.indexed && f.indexed !== "No" && !f.primaryKey);

  const set = (i: number, patch: Partial<Draft>) => {
    setList((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    setError(null);
  };

  const ok = () => {
    const names = new Set<string>();
    for (const ix of list) {
      const bad = validateName(ix.name);
      if (bad) return setError(`Index name "${ix.name}": ${bad}`);
      if (names.has(ix.name.toLowerCase())) return setError(`Two indexes are called ${ix.name}. Please give each a different name.`);
      names.add(ix.name.toLowerCase());
      if (!ix.fields.length) return setError(`Please add at least one field to ${ix.name}, or delete it.`);
      if (ix.unique) {
        const fields = ix.fields.map(named).filter((f): f is Field => !!f);
        const dup = firstDuplicate(table, fields);
        if (dup) {
          return setError(
            `${ix.name} can't be unique yet: more than one record has ${fields.map((f) => f.name).join(" + ")} = ${dup}. Please fix those records first, or untick Unique.`,
          );
        }
      }
    }
    const multi = list.filter((ix) => ix.fields.length > 1);
    const single = list.filter((ix) => ix.fields.length === 1).map((ix) => ({ fieldId: ix.fields[0], unique: ix.unique }));
    props.onOk(multi, single);
  };

  return (
    <Modal
      title={`Indexes: ${table.name}`}
      onClose={props.onClose}
      width={640}
      footer={
        <>
          <button
            onClick={() => {
              setList((l) => [...l, { id: newId("ix"), name: uniqueName(l, "Index"), fields: [], unique: true }]);
              setError(null);
            }}
          >
            + New Index
          </button>
          <span className="spacer" />
          <button className="primary" onClick={ok}>
            OK
          </button>
          <button onClick={props.onClose}>Cancel</button>
        </>
      }
    >
      <div className="ix">
        <p className="ix-intro small">
          An index makes searching and sorting faster. Tick <strong>Unique</strong> to make its fields' <em>combination</em> unique: for example, PetType + Breed
          lets "Dog" + "Beagle" appear only once, while "Dog" and "Beagle" can each appear in other records.
        </p>
        <div className="ix-pk">
          <span className="ix-key" aria-hidden="true">🔑</span>
          <strong>Primary key:</strong> {pk.length ? pk.map((f) => f.name).join(" + ") : <em className="muted">none</em>}
          <span className="small muted"> · To change it, select its field rows (Ctrl+click for several) and click Primary Key.</span>
        </div>
        {list.map((ix, i) => {
          const fields = ix.fields.map(named).filter((f): f is Field => !!f);
          const free = usable.filter((f) => !ix.fields.includes(f.id));
          return (
            <div key={ix.id} className="ix-row">
              <input className="ix-name" aria-label="Index name" value={ix.name} maxLength={64} onChange={(e) => set(i, { name: e.target.value })} />
              <div className="ix-fields" aria-label={`Fields in ${ix.name}`}>
                {fields.map((f, k) => (
                  <span key={f.id} className="ix-chip">
                    {k > 0 && <span className="ix-plus">+</span>}
                    {f.name}
                    <button aria-label={`Remove ${f.name}`} title="Remove" onClick={() => set(i, { fields: ix.fields.filter((id) => id !== f.id) })}>
                      ×
                    </button>
                  </span>
                ))}
                {free.length > 0 && (
                  <select
                    className="ix-add"
                    aria-label={`Add a field to ${ix.name}`}
                    value=""
                    onChange={(e) => e.target.value && set(i, { fields: [...ix.fields, e.target.value] })}
                  >
                    <option value="">{fields.length ? "+ field" : "Choose fields…"}</option>
                    {free.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <label className="ix-unique" title="No two records can have the same combination of these fields">
                <input type="checkbox" checked={ix.unique} onChange={(e) => set(i, { unique: e.target.checked })} /> Unique
              </label>
              <button className="ix-del" aria-label={`Delete ${ix.name}`} title="Delete this index" onClick={() => setList((l) => l.filter((_, j) => j !== i))}>
                🗑
              </button>
            </div>
          );
        })}
        {!list.length && <div className="ix-empty muted small">No indexes on more than one field yet. Click + New Index.</div>}
        {singles.length > 0 && (
          <div className="ix-singles small muted">
            Single fields (their Indexed property): {singles.map((f) => `${f.name}${f.indexed === "YesNoDup" ? " (unique)" : ""}`).join(", ")}.
          </div>
        )}
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

function uniqueName(list: { name: string }[], base: string) {
  const clean = base.replace(/[.![\]`]/g, "").slice(0, 60) || "Index";
  let n = clean;
  for (let i = 2; list.some((x) => x.name.toLowerCase() === n.toLowerCase()); i++) n = `${clean}${i}`;
  return n;
}
