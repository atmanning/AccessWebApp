import { useEffect, useMemo, useRef, useState } from "react";
import type { Field, Relationship, TableDef } from "../../../shared/model";
import { fieldsCompatible } from "../engine/integrity";
import { linkedRelations } from "../engine/queryDesign";
import { sourceFieldNames } from "./sqlDesignReader";
import { Modal, useDialogs } from "../ui/dialogs";
import { KeyIcon, LinkedTableIcon } from "../ui/icons";
import { useLayout } from "../ui/layout";
import { useCommands, useWorkspace } from "../workspace/context";
import { newId } from "../workspace/docOps";

const BOX_W = 170;
const HEAD_H = 24;
const ROW_H = 20;

type Draft = Omit<Relationship, "id"> & { id?: string };

/** A table in the window: one of this database's, or a linked MySQL table with foreign keys. */
interface Box {
  id: string;
  name: string;
  fields: { id: string; name: string; primaryKey?: boolean }[];
  linked?: boolean;
}

/** A field that names one record: the (single-field) primary key, or a unique index. */
const isUniqueKey = (t: TableDef | undefined, f: Field | undefined) =>
  !!f && ((f.primaryKey && (t?.fields.filter((x) => x.primaryKey).length ?? 1) === 1) || f.indexed === "YesNoDup");

/**
 * Like Access, the "one" side is whichever field is the primary key (or unique), whichever way you
 * dragged: dragging Employees.DepartmentID onto Departments.DepartmentID still makes Departments
 * the primary table.
 */
function oriented(doc: { tables: TableDef[] }, d: Draft): Draft {
  const fromT = doc.tables.find((t) => t.id === d.fromTable);
  const toT = doc.tables.find((t) => t.id === d.toTable);
  const fromF = fromT?.fields.find((f) => f.id === d.fromField);
  const toF = toT?.fields.find((f) => f.id === d.toField);
  if (!isUniqueKey(fromT, fromF) && isUniqueKey(toT, toF)) return { ...d, fromTable: d.toTable, fromField: d.toField, toTable: d.fromTable, toField: d.fromField };
  return d;
}

const typeName = (f: Field) => (f.type === "Number" ? `Number, ${f.numberSize ?? "Long"}` : f.type === "ShortText" ? "Short Text" : f.type === "LongText" ? "Long Text" : f.type === "DateTime" ? "Date/Time" : f.type === "YesNo" ? "Yes/No" : f.type);

const compatible = fieldsCompatible;

export function RelationshipsView({ tabKey }: { tabKey: string }) {
  const ws = useWorkspace();
  const dialogs = useDialogs();
  // Positions while a table is being dragged (and, for view-only users, where they've moved them).
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const { touch } = useLayout();
  const [picked, setPicked] = useState<{ table: string; field: string } | null>(null);
  const dragField = useRef<{ table: string; field: string } | null>(null);

  // Linked MySQL tables joined by foreign keys on the server are shown too (read-only, dashed lines).
  const remoteRels = useMemo(() => linkedRelations(ws.doc), [ws.doc]);
  const remoteLinks = useMemo(
    () => (ws.doc.linkedTables ?? []).filter((l) => remoteRels.some((r) => r.fromTable === l.name || r.toTable === l.name)),
    [ws.doc.linkedTables, remoteRels],
  );
  const [linkedFields, setLinkedFields] = useState<Record<string, { id: string; name: string }[]>>({});
  useEffect(() => {
    let cancelled = false;
    for (const l of remoteLinks) {
      sourceFieldNames(ws.doc, ws.projectId, l.name)?.then(
        (fields) => !cancelled && setLinkedFields((s) => ({ ...s, [l.id]: fields.map((f) => ({ id: f.name, name: f.name })) })),
        () => {},
      );
    }
    return () => {
      cancelled = true;
    };
  }, [remoteLinks.map((l) => l.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const tables: Box[] = useMemo(
    () => [
      ...ws.doc.tables,
      ...remoteLinks.map((l) => {
        // Until the server answers, show the fields the foreign keys name.
        const known = remoteRels.flatMap((r) => (r.fromTable === l.name ? [r.fromField] : r.toTable === l.name ? [r.toField] : []));
        return { id: l.id, name: l.name, linked: true, fields: linkedFields[l.id] ?? [...new Set(known)].map((n) => ({ id: n, name: n })) };
      }),
    ],
    [ws.doc.tables, remoteLinks, remoteRels, linkedFields],
  );
  // Saved with the database. Tables without a saved place go in rows below the arranged ones.
  const saved = ws.doc.relationshipLayout;
  const layout = useMemo(() => {
    const placed = tables.filter((t) => positions[t.id] ?? saved?.[t.id]);
    const below = placed.length
      ? Math.max(...placed.map((t) => (positions[t.id] ?? saved![t.id]).y + HEAD_H + t.fields.length * ROW_H)) + 40
      : 24;
    let n = 0;
    return new Map(
      tables.map((t) => {
        const p = positions[t.id] ?? saved?.[t.id];
        if (p) return [t.id, { ...p, t }];
        const i = n++;
        return [t.id, { x: 24 + (i % 4) * 240, y: below + Math.floor(i / 4) * 260, t }];
      }),
    );
  }, [tables, positions, saved]);

  const anchor = (tableId: string, fieldId: string, side: "left" | "right") => {
    const l = layout.get(tableId);
    if (!l) return null;
    const idx = l.t.fields.findIndex((f) => f.id === fieldId || (l.t.linked && f.name.toLowerCase() === fieldId.toLowerCase()));
    if (idx < 0) return null;
    return { x: side === "left" ? l.x : l.x + BOX_W, y: l.y + HEAD_H + idx * ROW_H + ROW_H / 2 };
  };

  const startDrag = (e: React.PointerEvent, id: string) => {
    if ((e.target as HTMLElement).closest("li")) return;
    e.preventDefault();
    const start = layout.get(id)!;
    const sx = e.clientX;
    const sy = e.clientY;
    let at = { x: start.x, y: start.y };
    const move = (ev: PointerEvent) => {
      at = { x: Math.round(Math.max(0, start.x + ev.clientX - sx)), y: Math.round(Math.max(0, start.y + ev.clientY - sy)) };
      setPositions((p) => ({ ...p, [id]: at }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (at.x === start.x && at.y === start.y) return;
      if (ws.readOnly) return; // view-only: the move lasts for this visit
      // Save every table's place (one undo step), so tables that were never moved stay put too.
      ws.update((d) => {
        const next: NonNullable<typeof d.relationshipLayout> = {};
        for (const [tid, l] of layout) next[tid] = { x: Math.round(l.x), y: Math.round(l.y) };
        next[id] = at;
        d.relationshipLayout = next;
      });
      setPositions((p) => {
        const { [id]: _, ...rest } = p;
        return rest;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const remove = async (id: string) => {
    if (!(await dialogs.confirm("Microsoft Access Web", "Are you sure you want to permanently delete the selected relationship from your database?", { okLabel: "Yes", danger: true }))) return;
    ws.update((d) => {
      d.relationships = d.relationships.filter((r) => r.id !== id);
    });
    setSelected(null);
  };

  useCommands(tabKey, {
    addRelationship: () => {
      const own = ws.doc.tables;
      if (own.length < 2) {
        ws.setStatus("Create at least two tables before adding a relationship.", "error");
        return;
      }
      setEditing({ fromTable: own[0].id, fromField: own[0].fields[0]?.id ?? "", toTable: own[1].id, toField: own[1].fields[0]?.id ?? "", enforce: true });
    },
    deleteRecord: () => selected && remove(selected),
  });

  const height = Math.max(400, ...[...layout.values()].map((l) => l.y + HEAD_H + l.t.fields.length * ROW_H + 40));
  const width = Math.max(800, ...[...layout.values()].map((l) => l.x + BOX_W + 40));

  return (
    <div className="relationships-view" tabIndex={0} onKeyDown={(e) => e.key === "Delete" && selected && remove(selected)}>
      <div className="rel-scroll">
      <div className="rel-canvas" style={{ width, height }}>
        <svg className="rel-lines" width={width} height={height}>
          {ws.doc.relationships.map((r) => {
            const fromL = layout.get(r.fromTable);
            const toL = layout.get(r.toTable);
            if (!fromL || !toL) return null;
            const leftToRight = fromL.x <= toL.x;
            const a = anchor(r.fromTable, r.fromField, leftToRight ? "right" : "left");
            const b = anchor(r.toTable, r.toField, leftToRight ? "left" : "right");
            if (!a || !b) return null;
            const dx = leftToRight ? 14 : -14;
            const d = `M${a.x} ${a.y} h${dx} L${b.x - dx} ${b.y} h${dx}`;
            const sel = selected === r.id;
            // A relationship whose fields no longer have matching types (changed before that was blocked).
            const ff = ws.doc.tables.find((t) => t.id === r.fromTable)?.fields.find((f) => f.id === r.fromField);
            const tf = ws.doc.tables.find((t) => t.id === r.toTable)?.fields.find((f) => f.id === r.toField);
            const bad = !!ff && !!tf && !compatible(ff, tf);
            return (
              <g key={r.id} className={`rel-line ${sel ? "selected" : ""} ${bad ? "bad" : ""}`} onClick={() => (setSelected(r.id), touch && setEditing({ ...r }))} onDoubleClick={() => setEditing({ ...r })}>
                {bad && <title>{`${ff!.name} (${typeName(ff!)}) and ${tf!.name} (${typeName(tf!)}) no longer have the same data type. Change one in Table Design so they match.`}</title>}
                <path d={d} className="hit" />
                <path d={d} className="stroke" />
                {r.enforce && (
                  <>
                    <text x={a.x + (leftToRight ? 3 : -10)} y={a.y - 4} className="rel-card">1</text>
                    <text x={b.x - (leftToRight ? 12 : -3)} y={b.y - 4} className="rel-card">∞</text>
                  </>
                )}
              </g>
            );
          })}
          {remoteRels.map((r, i) => {
            const fromBox = tables.find((t) => t.linked && t.name === r.fromTable);
            const toBox = tables.find((t) => t.linked && t.name === r.toTable);
            const fromL = fromBox && layout.get(fromBox.id);
            const toL = toBox && layout.get(toBox.id);
            if (!fromL || !toL) return null;
            const leftToRight = fromL.x <= toL.x;
            const a = anchor(fromBox!.id, r.fromField, leftToRight ? "right" : "left");
            const b = anchor(toBox!.id, r.toField, leftToRight ? "left" : "right");
            if (!a || !b) return null;
            const dx = leftToRight ? 14 : -14;
            const d = `M${a.x} ${a.y} h${dx} L${b.x - dx} ${b.y} h${dx}`;
            return (
              <g
                key={`remote${i}`}
                className="rel-line remote"
                onClick={() => ws.setStatus(`${r.fromTable}.${r.fromField} → ${r.toTable}.${r.toField} is a foreign key on the MySQL server. Change it there; Query Design joins these linked tables with it.`)}
              >
                <title>Foreign key on the MySQL server (read-only here)</title>
                <path d={d} className="hit" />
                <path d={d} className="stroke" />
                <text x={a.x + (leftToRight ? 3 : -10)} y={a.y - 4} className="rel-card">1</text>
                <text x={b.x - (leftToRight ? 12 : -3)} y={b.y - 4} className="rel-card">∞</text>
              </g>
            );
          })}
        </svg>
        {tables.map((t) => {
          const l = layout.get(t.id)!;
          return (
            <div key={t.id} className={`rel-box ${t.linked ? "linked" : ""}`} style={{ left: l.x, top: l.y, width: BOX_W }} onPointerDown={(e) => startDrag(e, t.id)}>
              <div className="rel-box-title" style={{ height: HEAD_H }} title={t.linked ? "Linked MySQL table: its relationships are foreign keys on the server" : undefined}>
                {t.linked && <LinkedTableIcon size={12} />}&nbsp;{t.name}
              </div>
              <ul>
                {t.linked && t.fields.map((f) => (
                  <li key={f.id} style={{ height: ROW_H }} className="rel-linked-field">
                    {f.name}
                  </li>
                ))}
                {!t.linked && t.fields.map((f) => (
                  <li
                    key={f.id}
                    style={{ height: ROW_H }}
                    className={picked?.table === t.id && picked.field === f.id ? "rel-picked" : undefined}
                    // Touch screens can't drag fields: tap one field, then a field in another table.
                    onClick={() => {
                      if (!touch) return;
                      if (!picked || picked.table === t.id) {
                        setPicked(picked?.field === f.id ? null : { table: t.id, field: f.id });
                        ws.setStatus(picked?.field === f.id ? "" : `Now tap the matching field in another table to relate it to '${f.name}'.`);
                        return;
                      }
                      setPicked(null);
                      ws.setStatus("");
                      setEditing(oriented(ws.doc, { fromTable: picked.table, fromField: picked.field, toTable: t.id, toField: f.id, enforce: true }));
                    }}
                    draggable={!touch}
                    onDragStart={(e) => {
                      dragField.current = { table: t.id, field: f.id };
                      e.dataTransfer.setData("text/plain", f.name);
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = dragField.current;
                      dragField.current = null;
                      if (!from || from.table === t.id) return;
                      setEditing(oriented(ws.doc, { fromTable: from.table, fromField: from.field, toTable: t.id, toField: f.id, enforce: true }));
                    }}
                    title={touch ? "Tap, then tap a field in another table to relate them" : "Drag onto a field in another table to relate them"}
                  >
                    {f.primaryKey && <KeyIcon size={11} />} {f.name}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {!ws.doc.tables.length && !remoteLinks.length && <div className="empty-view">Create some tables first, then relate them here.</div>}
      </div>
      </div>
      {(() => {
        const bad = ws.doc.relationships.filter((r) => {
          const ff = ws.doc.tables.find((t) => t.id === r.fromTable)?.fields.find((f) => f.id === r.fromField);
          const tf = ws.doc.tables.find((t) => t.id === r.toTable)?.fields.find((f) => f.id === r.toField);
          return ff && tf && !compatible(ff, tf);
        });
        if (!bad.length) return null;
        const desc = bad.map((r) => {
          const ft = ws.doc.tables.find((t) => t.id === r.fromTable)!;
          const tt = ws.doc.tables.find((t) => t.id === r.toTable)!;
          const ff = ft.fields.find((f) => f.id === r.fromField)!;
          const tf = tt.fields.find((f) => f.id === r.toField)!;
          return `${ft.name}.${ff.name} (${typeName(ff)}) ↔ ${tt.name}.${tf.name} (${typeName(tf)})`;
        });
        return <div className="rel-warning" role="alert">⚠ Related fields with different data types (dashed red line): {desc.join("; ")}. Change one in Table Design so they match.</div>;
      })()}
      <div className="rel-help muted small">
        {touch
          ? "Tap a field (usually the primary key), then the matching field in another table, to relate them. Tap a line to edit or delete it. Drag a table by its title to move it."
          : "Drag a field (usually the primary key) onto the matching field in another table to create a relationship. Click a line to select it; press Delete to remove it, double-click to edit."}
      </div>
      {editing && (
        <EditRelationshipDialog
          draft={editing}
          onClose={() => setEditing(null)}
          onDelete={editing.id ? () => (setEditing(null), void remove(editing.id!)) : undefined}
        />
      )}
    </div>
  );
}

function EditRelationshipDialog({ draft, onClose, onDelete }: { draft: Draft; onClose: () => void; onDelete?: () => void }) {
  const ws = useWorkspace();
  const [d, setD] = useState(() => oriented(ws.doc, draft));
  const [error, setError] = useState<string | null>(null);
  const tables = ws.doc.tables;
  const fromT = tables.find((t) => t.id === d.fromTable);
  const toT = tables.find((t) => t.id === d.toTable);
  const fromF = fromT?.fields.find((f) => f.id === d.fromField);
  const toF = toT?.fields.find((f) => f.id === d.toField);

  const save = () => {
    // The key side goes first, whichever way round the tables were picked.
    const o = oriented(ws.doc, d);
    if (o !== d) {
      setD(o);
      return saveAs(o);
    }
    saveAs(d);
  };
  const saveAs = (d: Draft) => {
    const fromT = tables.find((t) => t.id === d.fromTable);
    const toT = tables.find((t) => t.id === d.toTable);
    const fromF = fromT?.fields.find((f) => f.id === d.fromField);
    const toF = toT?.fields.find((f) => f.id === d.toField);
    if (!fromT || !toT || !fromF || !toF) return setError("Choose a table and field on each side.");
    if (fromT.id === toT.id) return setError("Pick two different tables.");
    if (!compatible(fromF, toF)) {
      return setError(`Relationship must be on the same number of fields with the same data types. '${fromF.name}' is ${fromF.type} and '${toF.name}' is ${toF.type}.`);
    }
    if (d.enforce) {
      if (!isUniqueKey(fromT, fromF)) {
        return setError(
          `To enforce referential integrity, one of the two fields must be its table's primary key, or have Indexed set to "Yes (No Duplicates)". ` +
            `Neither '${fromT.name}.${fromF.name}' nor '${toT.name}.${toF.name}' is. Usually the key is the ID in the table being pointed to (for example Departments.DepartmentID): make it the primary key in Table Design. ` +
            `"Yes (Duplicates OK)" isn't enough, because many records can share that value.`,
        );
      }
      const keys = new Set(fromT.rows.map((r) => r[fromF.id]));
      const orphan = toT.rows.find((r) => r[toF.id] !== null && r[toF.id] !== undefined && !keys.has(r[toF.id]));
      if (orphan) {
        return setError(`Data in the table '${toT.name}' violates referential integrity rules: '${toF.name}' = ${String(orphan[toF.id])} has no matching record in '${fromT.name}'.`);
      }
    }
    const dup = ws.doc.relationships.find(
      (r) => r.id !== d.id && r.fromTable === d.fromTable && r.fromField === d.fromField && r.toTable === d.toTable && r.toField === d.toField,
    );
    if (dup) return setError("This relationship already exists.");
    // The cascade options only mean something while integrity is enforced.
    const rel = { ...d, cascadeUpdate: (d.enforce && d.cascadeUpdate) || undefined, cascadeDelete: (d.enforce && d.cascadeDelete) || undefined };
    ws.update((doc) => {
      if (d.id) {
        const r = doc.relationships.find((x) => x.id === d.id)!;
        Object.assign(r, rel);
        if (!rel.cascadeUpdate) delete r.cascadeUpdate;
        if (!rel.cascadeDelete) delete r.cascadeDelete;
      } else {
        const r = { ...rel, id: newId("rel") };
        if (!r.cascadeUpdate) delete r.cascadeUpdate;
        if (!r.cascadeDelete) delete r.cascadeDelete;
        doc.relationships.push(r);
      }
    });
    onClose();
  };

  const tableSelect = (value: string, onChange: (id: string) => void, label: string) => (
    <select className="text-input" value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      {tables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  );
  const fieldSelect = (t: TableDef | undefined, value: string, onChange: (id: string) => void, label: string) => (
    <select className="text-input" value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      {t?.fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
    </select>
  );

  return (
    <Modal
      title="Edit Relationships"
      onClose={onClose}
      width={520}
      footer={
        <>
          {onDelete && <button className="danger" onClick={onDelete}>Delete</button>}
          {onDelete && <span className="spacer" />}
          <button className="primary" onClick={save}>{d.id ? "OK" : "Create"}</button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <div className="rel-edit">
        <div>
          <div className="small">Table/Query:</div>
          {tableSelect(d.fromTable, (id) => setD({ ...d, fromTable: id, fromField: tables.find((t) => t.id === id)?.fields.find((f) => f.primaryKey)?.id ?? tables.find((t) => t.id === id)?.fields[0]?.id ?? "" }), "Primary table")}
          {fieldSelect(fromT, d.fromField, (id) => setD({ ...d, fromField: id }), "Primary field")}
        </div>
        <div>
          <div className="small">Related Table/Query:</div>
          {tableSelect(d.toTable, (id) => setD({ ...d, toTable: id, toField: tables.find((t) => t.id === id)?.fields[0]?.id ?? "" }), "Related table")}
          {fieldSelect(toT, d.toField, (id) => setD({ ...d, toField: id }), "Related field")}
        </div>
      </div>
      <label className="check-label">
        <input type="checkbox" checked={d.enforce} onChange={(e) => setD({ ...d, enforce: e.target.checked })} /> Enforce Referential Integrity
      </label>
      <div className={`rel-cascades ${d.enforce ? "" : "off"}`}>
        <label className="check-label" title="Changing the key in the primary table changes it in the related records too, instead of being refused.">
          <input type="checkbox" disabled={!d.enforce} checked={d.enforce && !!d.cascadeUpdate} onChange={(e) => setD({ ...d, cascadeUpdate: e.target.checked })} /> Cascade Update Related Fields
        </label>
        <label className="check-label" title="Deleting a record in the primary table deletes its related records too, instead of being refused.">
          <input type="checkbox" disabled={!d.enforce} checked={d.enforce && !!d.cascadeDelete} onChange={(e) => setD({ ...d, cascadeDelete: e.target.checked })} /> Cascade Delete Related Records
        </label>
        {d.enforce && (
          <div className="small muted rel-cascade-help">
            {d.cascadeUpdate ? `Changing a ${fromF?.name ?? "key"} in ${fromT?.name ?? "the primary table"} also changes it in ${toT?.name ?? "the related table"}. ` : ""}
            {d.cascadeDelete ? `Deleting a ${fromT?.name ?? "primary"} record also deletes its ${toT?.name ?? "related"} records. ` : ""}
            {!d.cascadeUpdate && !d.cascadeDelete ? `A ${fromT?.name ?? "primary"} record that has ${toT?.name ?? "related"} records can't be deleted, and its ${fromF?.name ?? "key"} can't be changed.` : ""}
          </div>
        )}
      </div>
      <div className="small muted">Relationship Type: {fromF?.primaryKey || fromF?.indexed === "YesNoDup" ? (toF?.primaryKey ? "One-To-One" : "One-To-Many") : "Indeterminate"}</div>
      {error && <div className="field-error">{error}</div>}
    </Modal>
  );
}
