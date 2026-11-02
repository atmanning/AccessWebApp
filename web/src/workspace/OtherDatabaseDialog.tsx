/**
 * External Data → Access Web Database: import or link tables and queries from another database
 * in this app that you can open (your own, or one shared with you).
 */
import { useEffect, useState } from "react";
import type { ProjectDoc, ProjectRecord, ProjectSummary, QueryDef, Relationship, Row, TableDef } from "../../../shared/model";
import { api } from "../api";
import { tokenize } from "../engine/accessSql";
import { isActionType, queryTypeOf } from "../engine/statements";
import { Modal } from "../ui/dialogs";
import { QueryIcon, TableIcon } from "../ui/icons";
import { useWorkspace } from "./context";
import { newId, uniqueObjectName } from "./docOps";

export type OtherDbMode = "import" | "link";

const typeOf = (q: QueryDef) => (q.mode === "design" && q.design?.type ? q.design.type : queryTypeOf(q.sql));

/** Rewrites table/query names in Access SQL after objects were renamed on import. */
export function renameInSql(sql: string, renames: Map<string, string>): string {
  if (!renames.size) return sql;
  let tokens;
  try {
    tokens = tokenize(sql);
  } catch {
    return sql;
  }
  let out = "";
  let pos = 0;
  let prev: (typeof tokens)[number] | null = null;
  for (const t of tokens) {
    const before = prev;
    if (t.kind !== "ws") prev = t;
    if (t.kind !== "ident" && t.kind !== "word") continue;
    // "AS name" is an alias and "x.name" a field: neither is a table or query reference.
    if (before && (before.text === "." || (before.kind === "word" && before.text.toUpperCase() === "AS"))) continue;
    const name = t.kind === "ident" ? t.text.slice(1, -1) : t.text;
    const to = renames.get(name.toLowerCase());
    if (!to) continue;
    out += sql.slice(pos, t.start) + `[${to}]`;
    pos = t.start + t.text.length;
  }
  return out + sql.slice(pos);
}

export interface ImportResult {
  doc: ProjectDoc;
  notes: string[];
  counts: { tables: number; queries: number; records: number };
}

/** Copies the chosen tables (with or without data), queries and relationships between them. */
export function importFromDatabase(
  target: ProjectDoc,
  source: ProjectRecord,
  tableIds: Set<string>,
  queryIds: Set<string>,
  opts: { withData: boolean; relationships: boolean },
): ImportResult {
  const doc: ProjectDoc = structuredClone(target);
  const notes: string[] = [];
  const renames = new Map<string, string>();
  const tableMap = new Map<string, { table: TableDef; fields: Map<string, string> }>();
  let records = 0;

  for (const t of source.doc.tables.filter((x) => tableIds.has(x.id))) {
    const name = uniqueObjectName(doc, "table", t.name);
    if (name !== t.name) renames.set(t.name.toLowerCase(), name);
    const fields = new Map(t.fields.map((f) => [f.id, newId("f")]));
    const table: TableDef = {
      ...structuredClone(t),
      id: newId("t"),
      name,
      fields: t.fields.map((f) => ({ ...f, id: fields.get(f.id)! })),
      rows: opts.withData
        ? t.rows.map((r) => {
            const row: Row = { _id: newId("r") };
            for (const [from, to] of fields) row[to] = r[from] ?? null;
            return row;
          })
        : [],
      nextAutoNumber: opts.withData ? t.nextAutoNumber : 1,
      columnWidths: t.columnWidths && Object.fromEntries(Object.entries(t.columnWidths).flatMap(([k, v]) => (fields.has(k) ? [[fields.get(k)!, v]] : []))),
    };
    records += table.rows.length;
    doc.tables.push(table);
    tableMap.set(t.id, { table, fields });
  }

  const queries = source.doc.queries.filter((x) => queryIds.has(x.id));
  // Names first, so queries that use each other are renamed consistently.
  const queryNames = queries.map((q) => {
    const name = uniqueObjectName({ ...doc, queries: [...doc.queries] }, "query", q.name);
    // Reserve it straight away so two picks can't get the same new name.
    doc.queries.push({ ...q, id: newId("q"), name });
    if (name !== q.name) renames.set(q.name.toLowerCase(), name);
    return name;
  });
  doc.queries.splice(doc.queries.length - queries.length, queries.length);
  queries.forEach((q, i) => {
    const copy: QueryDef = { ...structuredClone(q), id: newId("q"), name: queryNames[i], sql: renameInSql(q.sql, renames) };
    if (copy.design) {
      const rn = (n: string) => renames.get(n.toLowerCase()) ?? n;
      copy.design.tables = copy.design.tables.map(rn);
      copy.design.columns = copy.design.columns.map((c) => ({ ...c, table: c.table ? rn(c.table) : c.table }));
      if (copy.design.target) copy.design.target = rn(copy.design.target);
      if (copy.design.joins) copy.design.joins = copy.design.joins.map((j) => ({ ...j, t1: rn(j.t1), t2: rn(j.t2) }));
      if (copy.design.boxes) copy.design.boxes = Object.fromEntries(Object.entries(copy.design.boxes).map(([k, v]) => [rn(k), v]));
    }
    doc.queries.push(copy);
  });

  if (opts.relationships) {
    for (const r of source.doc.relationships) {
      const from = tableMap.get(r.fromTable);
      const to = tableMap.get(r.toTable);
      if (!from || !to) continue;
      const rel: Relationship = { ...r, id: newId("rel"), fromTable: from.table.id, fromField: from.fields.get(r.fromField)!, toTable: to.table.id, toField: to.fields.get(r.toField)! };
      if (rel.fromField && rel.toField) doc.relationships.push(rel);
    }
  }

  for (const [from, to] of renames) {
    const orig = [...source.doc.tables, ...source.doc.queries].find((o) => o.name.toLowerCase() === from)?.name ?? from;
    notes.push(`'${orig}' was renamed to '${to}' because that name is already used here; imported queries were updated to match.`);
  }
  // Queries that use tables or queries that aren't here.
  const here = new Set([...doc.tables, ...doc.queries, ...(doc.linkedTables ?? [])].map((o) => o.name.toLowerCase()));
  const sourceNames = new Map([...source.doc.tables, ...source.doc.queries, ...(source.doc.linkedTables ?? [])].map((o) => [o.name.toLowerCase(), o.name]));
  for (let i = 0; i < queries.length; i++) {
    const missing = new Set<string>();
    try {
      for (const t of tokenize(doc.queries[doc.queries.length - queries.length + i].sql)) {
        if (t.kind !== "ident" && t.kind !== "word") continue;
        const n = (t.kind === "ident" ? t.text.slice(1, -1) : t.text).toLowerCase();
        if (sourceNames.has(n) && !here.has(n)) missing.add(sourceNames.get(n)!);
      }
    } catch {
      /* unreadable SQL: it will say so when run */
    }
    if (missing.size) notes.push(`The query '${queryNames[i]}' uses ${[...missing].map((m) => `'${m}'`).join(", ")}, which ${missing.size === 1 ? "isn't" : "aren't"} in this database. Import or link ${missing.size === 1 ? "it" : "them"} too.`);
  }
  return { doc, notes, counts: { tables: tableMap.size, queries: queries.length, records } };
}

/** Access-style "Get External Data – Access Web Database" dialog. */
export function OtherDatabaseDialog(props: { mode: OtherDbMode; onClose: () => void; onDone: (message: string, notes: string[]) => void }) {
  const ws = useWorkspace();
  const [mode, setMode] = useState<OtherDbMode>(props.mode);
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [pickedDb, setPickedDb] = useState<string | null>(null);
  const [source, setSource] = useState<ProjectRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"tables" | "queries">("tables");
  const [tables, setTables] = useState<Set<string>>(new Set());
  const [queries, setQueries] = useState<Set<string>>(new Set());
  const [withData, setWithData] = useState(true);
  const [withRels, setWithRels] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listProjects().then(
      (r) => setList([...r.projects, ...r.shared].filter((p) => p.id !== ws.projectId)),
      (e) => setError((e as Error).message),
    );
  }, [ws.projectId]);

  const openDb = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.getProject(id);
      setSource(project);
      setTables(new Set());
      setQueries(new Set());
      setTab(project.doc.tables.length || !project.doc.queries.length ? "tables" : "queries");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const linkable = (q: QueryDef) => !isActionType(typeOf(q));
  const shownQueries = source ? source.doc.queries.filter((q) => mode === "import" || linkable(q)) : [];
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setter(n);
  };

  const ok = () => {
    if (!source) return;
    if (!tables.size && !queries.size) return setError("Choose at least one table or query.");
    if (mode === "import") {
      const r = importFromDatabase(ws.doc, source, tables, queries, { withData, relationships: withRels });
      ws.update((d) => {
        d.tables = r.doc.tables;
        d.queries = r.doc.queries;
        d.relationships = r.doc.relationships;
      });
      props.onDone(
        `Imported ${r.counts.tables} table(s)${withData ? ` with ${r.counts.records.toLocaleString()} record(s)` : ""} and ${r.counts.queries} quer${r.counts.queries === 1 ? "y" : "ies"} from '${source.name}'.`,
        r.notes,
      );
      return;
    }
    const notes: string[] = [];
    let count = 0;
    ws.update((d) => {
      d.linkedTables ??= [];
      const picks = [
        ...source.doc.tables.filter((t) => tables.has(t.id)).map((t) => ({ kind: "table" as const, obj: t })),
        ...source.doc.queries.filter((q) => queries.has(q.id)).map((q) => ({ kind: "query" as const, obj: q })),
      ];
      for (const { kind, obj } of picks) {
        const name = uniqueObjectName(d, "linked", obj.name);
        if (name !== obj.name) notes.push(`'${obj.name}' is linked as '${name}' because that name is already used here.`);
        d.linkedTables.push({
          id: newId("lt"),
          name,
          sourceProject: source.id,
          sourceKind: kind,
          sourceId: obj.id,
          sourceName: obj.name,
          sourceProjectName: source.name.slice(0, 200),
        });
        count++;
      }
    });
    props.onDone(`Linked ${count} object(s) from '${source.name}'. They're in the Tables group with a link icon.`, notes);
  };

  const items =
    tab === "tables"
      ? (source?.doc.tables ?? []).map((t) => ({ id: t.id, name: t.name, detail: `${t.rows.length.toLocaleString()} record(s)`, icon: <TableIcon /> }))
      : shownQueries.map((q) => ({ id: q.id, name: q.name, detail: typeOf(q) === "select" ? "" : typeOf(q), icon: <QueryIcon /> }));
  const picked = tab === "tables" ? tables : queries;
  const setPicked = tab === "tables" ? setTables : setQueries;
  const hiddenActions = source && mode === "link" ? source.doc.queries.length - shownQueries.length : 0;

  return (
    <Modal
      title={source ? (mode === "import" ? "Import Objects" : "Link Tables") : "Get External Data – Access Web Database"}
      onClose={props.onClose}
      width={560}
      footer={
        source ? (
          <>
            <button onClick={() => setSource(null)}>Back</button>
            <span className="spacer" />
            <button className="primary" disabled={busy || (!tables.size && !queries.size)} onClick={ok}>OK</button>
            <button onClick={props.onClose}>Cancel</button>
          </>
        ) : (
          <>
            <span className="spacer" />
            <button className="primary" disabled={!pickedDb || busy} onClick={() => pickedDb && void openDb(pickedDb)}>
              {busy ? "Opening…" : "Next"}
            </button>
            <button onClick={props.onClose}>Cancel</button>
          </>
        )
      }
    >
      {!source ? (
        <div className="otherdb">
          <p className="small">Choose a database you own or that's shared with you, then how to bring its data here:</p>
          <fieldset className="paste-options">
            <label className="check-label">
              <input type="radio" name="otherdb-mode" checked={mode === "import"} onChange={() => setMode("import")} />
              <span>
                <strong>Import</strong> tables and queries into this database. You get your own copy; later changes in either
                database don't affect the other.
              </span>
            </label>
            <label className="check-label">
              <input type="radio" name="otherdb-mode" checked={mode === "link"} onChange={() => setMode("link")} />
              <span>
                <strong>Link</strong> to tables and select queries. You always see the source's current data (read-only here);
                only people who can open the source database can open the link.
              </span>
            </label>
          </fieldset>
          <div className="otherdb-list list" role="listbox" aria-label="Databases">
            {list === null && !error && <div className="muted small">Loading your databases…</div>}
            {list?.length === 0 && <div className="muted small">You have no other databases, and none are shared with you.</div>}
            {list?.map((p) => (
              <button
                key={p.id}
                role="option"
                aria-selected={pickedDb === p.id}
                className={`list-item ${pickedDb === p.id ? "selected" : ""}`}
                onClick={() => setPickedDb(p.id)}
                onDoubleClick={() => void openDb(p.id)}
              >
                <span>{p.name}</span>
                <span className="muted small">
                  {p.role === "owner" ? "Yours" : `Shared by ${p.ownerName} · can ${p.role}`} · {p.tableCount} table(s)
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="otherdb">
          <p className="small">
            From <strong>{source.name}</strong>
            {source.role !== "owner" && <> (shared by {source.ownerName})</>}. Select the objects to {mode}:
          </p>
          <div className="otherdb-tabs" role="tablist">
            {(["tables", "queries"] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                {t === "tables" ? "Tables" : "Queries"}
                {(t === "tables" ? tables : queries).size > 0 && ` (${(t === "tables" ? tables : queries).size})`}
              </button>
            ))}
          </div>
          <div className="remote-tables otherdb-objects">
            {items.map((it) => (
              <label key={it.id} className="list-item check-item">
                <input type="checkbox" checked={picked.has(it.id)} onChange={() => toggle(picked, setPicked, it.id)} />
                {it.icon} {it.name}
                <span className="muted small">{it.detail}</span>
              </label>
            ))}
            {!items.length && <div className="muted small">No {tab} {tab === "queries" && mode === "link" ? "that can be linked" : ""} in this database.</div>}
          </div>
          <div className="otherdb-row">
            <button onClick={() => setPicked(new Set(items.map((i) => i.id)))} disabled={!items.length}>Select All</button>
            <button onClick={() => setPicked(new Set())} disabled={!picked.size}>Deselect All</button>
            {hiddenActions > 0 && tab === "queries" && <span className="muted small">Action queries can't be linked; import them instead.</span>}
          </div>
          {mode === "import" && (
            <fieldset className="paste-options">
              <legend>Import Options</legend>
              <label className="check-label">
                <input type="radio" name="otherdb-data" checked={withData} onChange={() => setWithData(true)} />
                Tables: Definition and Data
              </label>
              <label className="check-label">
                <input type="radio" name="otherdb-data" checked={!withData} onChange={() => setWithData(false)} />
                Tables: Definition Only
              </label>
              <label className="check-label">
                <input type="checkbox" checked={withRels} onChange={(e) => setWithRels(e.target.checked)} />
                Relationships between the imported tables
              </label>
            </fieldset>
          )}
        </div>
      )}
      {error && <div className="field-error">{error}</div>}
    </Modal>
  );
}
