/**
 * Copy and paste of database objects (Ctrl+C / Ctrl+V in the Navigation Pane, like Access).
 * The clipboard lives in this browser, so you can paste into another database you open.
 */
import { useState } from "react";
import type { FormDef, LinkedTable, ObjectKind, ProjectDoc, QueryDef, ReportDef, Row, TableDef } from "../../../shared/model";
import { appendRowsPlan } from "../engine/actions";
import { Modal, useDialogs } from "../ui/dialogs";
import { useWorkspace } from "./context";
import { KIND_LABEL, newId, uniqueObjectName, validateObjectName } from "./docOps";

export interface ClipItem {
  kind: ObjectKind;
  object: TableDef | QueryDef | FormDef | ReportDef | LinkedTable;
  projectId: string;
  /** Forms and reports: their record source by name, to reconnect in another database. */
  source?: { kind: "table" | "query"; name: string };
}

const KEY = "accessweb.clipboard";
let memory: ClipItem | null = null;

export function copyObject(doc: ProjectDoc, projectId: string, kind: ObjectKind, id: string): ClipItem | null {
  const list = { table: doc.tables, query: doc.queries, form: doc.forms, report: doc.reports, linked: doc.linkedTables ?? [] }[kind] as { id: string; name: string }[];
  const object = list.find((o) => o.id === id);
  if (!object) return null;
  const item: ClipItem = { kind, object: structuredClone(object) as ClipItem["object"], projectId };
  if (kind === "form" || kind === "report") {
    const src = (object as FormDef).source;
    const named = (src.kind === "table" ? doc.tables : doc.queries).find((o) => o.id === src.id);
    if (named) item.source = { kind: src.kind, name: named.name };
  }
  memory = item;
  try {
    localStorage.setItem(KEY, JSON.stringify(item));
  } catch {
    // Too big for browser storage (or storage blocked): paste still works in this tab.
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }
  return item;
}

export function readClipboard(): ClipItem | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as ClipItem;
  } catch {
    /* fall back to this tab's copy */
  }
  return memory;
}

/** Copies a table with fresh ids (rows keyed by the new field ids). */
function cloneTable(t: TableDef, name: string, withData: boolean): TableDef {
  const fieldIds = new Map(t.fields.map((f) => [f.id, newId("f")]));
  return {
    ...t,
    id: newId("t"),
    name,
    fields: t.fields.map((f) => ({ ...f, id: fieldIds.get(f.id)! })),
    rows: withData
      ? t.rows.map((r) => {
          const row: Row = { _id: newId("r") };
          for (const [oldId, nid] of fieldIds) row[nid] = r[oldId] ?? null;
          return row;
        })
      : [],
    nextAutoNumber: withData ? t.nextAutoNumber : 1,
    columnWidths: t.columnWidths && Object.fromEntries(Object.entries(t.columnWidths).flatMap(([k, v]) => (fieldIds.has(k) ? [[fieldIds.get(k)!, v]] : []))),
  };
}

type TableMode = "structure" | "data" | "append";

/** Access's "Paste Table As" / "Paste As" dialog. */
export function PasteDialog({ item, onClose }: { item: ClipItem; onClose: () => void }) {
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const kindForNames = item.kind === "linked" ? "table" : item.kind;
  const [name, setName] = useState(() => uniqueObjectName(ws.doc, kindForNames, `Copy Of ${item.object.name}`.slice(0, 64)));
  const [mode, setMode] = useState<TableMode>("data");
  const [error, setError] = useState<string | null>(null);
  const isTable = item.kind === "table";
  const appendTarget = mode === "append" ? ws.doc.tables.find((t) => t.name.toLowerCase() === name.trim().toLowerCase()) : undefined;

  const paste = async () => {
    const n = name.trim();
    if (isTable && mode === "append") {
      const src = item.object as TableDef;
      const target = appendTarget;
      if (!target) return setError(`There's no table named '${n}' to append to. Type the name of an existing table.`);
      // Match fields by name, like Access does.
      const pairs = src.fields.flatMap((f) => {
        const tf = target.fields.find((x) => x.name.toLowerCase() === f.name.toLowerCase());
        return tf ? [{ from: f, to: tf }] : [];
      });
      if (!pairs.length) return setError(`'${src.name}' and '${target.name}' have no fields with the same names.`);
      const plan = appendRowsPlan(ws.doc, target, pairs.map((p) => p.to), src.rows.map((r) => pairs.map((p) => r[p.from.id] ?? null)));
      onClose();
      const ok = await dialogs.confirm(
        "Paste Append",
        <>
          <p>{plan.confirm}</p>
          {plan.problems.map((p) => <p key={p}>{p}</p>)}
          {pairs.length < src.fields.length && <p className="small muted">Fields without a match in {target.name} are left out.</p>}
        </>,
        { okLabel: "Yes" },
      );
      if (!ok) return;
      ws.update(plan.apply);
      ws.setStatus(plan.done);
      return;
    }
    const err = validateObjectName(ws.doc, kindForNames, n);
    if (err) return setError(err);
    const warnings: string[] = [];
    let created: { kind: ObjectKind; id: string } | null = null;
    ws.update((d) => {
      switch (item.kind) {
        case "table": {
          const t = cloneTable(item.object as TableDef, n, mode === "data");
          d.tables.push(t);
          created = { kind: "table", id: t.id };
          break;
        }
        case "query": {
          const q = { ...(item.object as QueryDef), id: newId("q"), name: n };
          d.queries.push(q);
          created = { kind: "query", id: q.id };
          break;
        }
        case "linked": {
          const l = { ...(item.object as LinkedTable), id: newId("lt"), name: n };
          if (l.connectionId && !ws.connections?.some((c) => c.id === l.connectionId)) {
            warnings.push("Its MySQL connection isn't part of this database, so the link won't open until you re-link it.");
          }
          d.linkedTables = [...(d.linkedTables ?? []), l];
          created = { kind: "linked", id: l.id };
          break;
        }
        default: {
          const o = structuredClone(item.object) as FormDef | ReportDef;
          o.id = newId(item.kind === "form" ? "fm" : "rp");
          o.name = n;
          // Reconnect the record source: same database keeps it, else find it by name.
          const sameDb = item.projectId === ws.projectId && (o.source.kind === "table" ? d.tables : d.queries).some((x) => x.id === o.source.id);
          if (!sameDb && item.source) {
            const match = (item.source.kind === "table" ? d.tables : d.queries).find((x) => x.name.toLowerCase() === item.source!.name.toLowerCase());
            if (match) o.source = { kind: item.source.kind, id: match.id };
            else warnings.push(`Its record source '${item.source.name}' isn't in this database. Choose another in Design View.`);
          }
          if (item.kind === "form") d.forms.push(o as FormDef);
          else d.reports.push(o as ReportDef);
          created = { kind: item.kind, id: o.id };
        }
      }
    });
    onClose();
    if (created) ws.setStatus(`Pasted ${KIND_LABEL[item.kind].toLowerCase()} '${n}'.${warnings.length ? " " + warnings.join(" ") : ""}`, warnings.length ? "error" : "info");
  };

  return (
    <Modal
      title={isTable ? "Paste Table As" : "Paste As"}
      onClose={onClose}
      width={400}
      footer={
        <>
          <button className="primary" onClick={() => void paste()}>OK</button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <label className="paste-name">
        {isTable ? "Table Name:" : `${KIND_LABEL[item.kind]} Name:`}
        <input
          className="text-input wide"
          value={name}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && void paste()}
          list={mode === "append" ? "paste-tables" : undefined}
        />
        <datalist id="paste-tables">
          {ws.doc.tables.map((t) => (
            <option key={t.id} value={t.name} />
          ))}
        </datalist>
      </label>
      {isTable && (
        <fieldset className="paste-options">
          <legend>Paste Options</legend>
          {(
            [
              ["structure", "Structure Only"],
              ["data", "Structure and Data"],
              ["append", "Append Data to Existing Table"],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className="check-label">
              <input
                type="radio"
                name="paste-mode"
                checked={mode === v}
                onChange={() => {
                  setMode(v);
                  setError(null);
                  if (v === "append" && !ws.doc.tables.some((t) => t.name === name)) setName(ws.doc.tables[0]?.name ?? "");
                }}
              />
              {label}
            </label>
          ))}
          {mode === "append" && <p className="small muted">Type or pick the existing table. Fields are matched by name.</p>}
        </fieldset>
      )}
      {error && <div className="field-error">{error}</div>}
    </Modal>
  );
}
