import { produce } from "immer";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ObjectKind, ProjectDoc, ProjectRecord, UserInfo } from "../../../shared/model";
import { api, ApiError } from "../api";
import { Modal, useDialogs } from "../ui/dialogs";
import { AccessIcon, BackIcon, CloseIcon, OBJECT_ICONS, RedoIcon, RelationshipsIcon, SaveIcon, UndoIcon } from "../ui/icons";
import { FormReportDesign, FormView, ReportView } from "../views/FormReportViews";
import { QueryDatasheet, QueryDesignView, QuerySqlView } from "../views/QueryViews";
import { RelationshipsView } from "../views/RelationshipsView";
import { TableDatasheet } from "../views/TableDatasheet";
import { TableDesign } from "../views/TableDesign";
import {
  defaultView,
  tabKey,
  viewsFor,
  WorkspaceContext,
  type StatusKind,
  type Tab,
  type TabKind,
  type ViewCommands,
  type ViewName,
  type WorkspaceApi,
  useWorkspace as useWorkspaceDoc,
} from "./context";
import { findObject, KIND_LABEL, newId, newTable, uniqueObjectName, validateObjectName } from "./docOps";
import { ImportCsvDialog } from "./ImportCsvDialog";
import { NavPane, type Selection } from "./NavPane";
import { Ribbon } from "./Ribbon";

type SaveState = "saved" | "pending" | "saving" | "error" | "conflict";
const MAX_UNDO = 100;

export function Workspace(props: { project: ProjectRecord; user: UserInfo; onClose: () => void; onSignOut: () => void }) {
  const dialogs = useDialogs();
  const [doc, setDoc] = useState<ProjectDoc>(props.project.doc);
  const [name, setName] = useState(props.project.name);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [status, setStatusState] = useState<{ message: string; kind: StatusKind }>({ message: "Ready", kind: "info" });
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [backstage, setBackstage] = useState(false);
  const [importing, setImporting] = useState(false);
  const [sourcePicker, setSourcePicker] = useState<"form" | "report" | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [, forceRibbon] = useState(0);

  const revision = useRef(props.project.revision);
  const docRef = useRef(doc);
  docRef.current = doc;
  const history = useRef<{ past: ProjectDoc[]; future: ProjectDoc[] }>({ past: [], future: [] });
  const commands = useRef(new Map<string, ViewCommands>());
  const savedDoc = useRef(doc);
  const saving = useRef(false);

  const setStatus = useCallback((message: string, kind: StatusKind = "info") => setStatusState({ message: message || "Ready", kind }), []);

  // ---- Saving -----------------------------------------------------------------------------
  const save = useCallback(async () => {
    if (saving.current) return;
    const toSave = docRef.current;
    if (toSave === savedDoc.current) {
      setSaveState("saved");
      return;
    }
    saving.current = true;
    setSaveState("saving");
    try {
      const res = await api.saveProject(props.project.id, revision.current, { doc: toSave });
      revision.current = res.project.revision;
      savedDoc.current = toSave;
      setSaveState(docRef.current === toSave ? "saved" : "pending");
    } catch (e) {
      const err = e as ApiError;
      setSaveState(err.status === 409 ? "conflict" : "error");
      setStatus(err.message, "error");
    } finally {
      saving.current = false;
    }
  }, [props.project.id, setStatus]);

  useEffect(() => {
    if (doc === savedDoc.current || saveState === "conflict") return;
    setSaveState((s) => (s === "saving" ? s : "pending"));
    const t = setTimeout(save, 700);
    return () => clearTimeout(t);
  }, [doc, save, saveState]);

  // Retry a pending save after an in-flight one finishes.
  useEffect(() => {
    if (saveState === "pending" && !saving.current) {
      const t = setTimeout(save, 700);
      return () => clearTimeout(t);
    }
  }, [saveState, save]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (docRef.current !== savedDoc.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // ---- Document updates and undo -----------------------------------------------------------
  const update = useCallback((recipe: (d: ProjectDoc) => void) => {
    const prev = docRef.current;
    const next = produce(prev, recipe);
    if (next === prev) return;
    history.current.past.push(prev);
    if (history.current.past.length > MAX_UNDO) history.current.past.shift();
    history.current.future = [];
    docRef.current = next;
    setDoc(next);
  }, []);

  const undo = useCallback(() => {
    const prev = history.current.past.pop();
    if (!prev) return setStatus("Nothing to undo.");
    history.current.future.push(docRef.current);
    docRef.current = prev;
    setDoc(prev);
    setStatus("Undone.");
  }, [setStatus]);

  const redo = useCallback(() => {
    const next = history.current.future.pop();
    if (!next) return setStatus("Nothing to redo.");
    history.current.past.push(docRef.current);
    docRef.current = next;
    setDoc(next);
    setStatus("Redone.");
  }, [setStatus]);

  // ---- Tabs ------------------------------------------------------------------------------
  const openObject = useCallback((kind: TabKind, id: string, view?: ViewName) => {
    const key = tabKey(kind, id);
    setTabs((ts) => {
      const existing = ts.find((t) => t.key === key);
      if (existing) return view && existing.view !== view ? ts.map((t) => (t.key === key ? { ...t, view } : t)) : ts;
      return [...ts, { key, kind, id, view: view ?? defaultView(kind) }];
    });
    setActiveKey(key);
    setBackstage(false);
    if (kind !== "relationships") setSelection({ kind, id });
  }, []);

  const closeTab = useCallback((key: string) => {
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.key === key);
      if (i < 0) return ts;
      const next = ts.filter((t) => t.key !== key);
      setActiveKey((a) => (a === key ? (next[i] ?? next[i - 1])?.key ?? null : a));
      return next;
    });
  }, []);

  const setTabView = useCallback((key: string, view: ViewName) => {
    setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, view } : t)));
    setStatus("");
  }, [setStatus]);

  const registerCommands = useCallback((key: string, cmds: ViewCommands | null) => {
    const had = commands.current.has(key);
    if (cmds) commands.current.set(key, cmds);
    else commands.current.delete(key);
    if (had !== !!cmds) forceRibbon((n) => n + 1);
  }, []);

  // Close tabs whose objects were deleted (e.g. by undo of a create).
  useEffect(() => {
    setTabs((ts) => {
      const alive = ts.filter((t) => t.kind === "relationships" || findObject(doc, t.kind, t.id));
      return alive.length === ts.length ? ts : alive;
    });
  }, [doc]);
  useEffect(() => {
    if (activeKey && !tabs.some((t) => t.key === activeKey)) setActiveKey(tabs[tabs.length - 1]?.key ?? null);
  }, [tabs, activeKey]);

  const activeTab = tabs.find((t) => t.key === activeKey) ?? null;

  const wsApi: WorkspaceApi = useMemo(
    () => ({
      projectId: props.project.id,
      projectName: name,
      doc,
      update,
      openObject,
      closeTab,
      setTabView,
      activeKey,
      setStatus,
      registerCommands,
    }),
    [props.project.id, name, doc, update, openObject, closeTab, setTabView, activeKey, setStatus, registerCommands],
  );

  // ---- Commands ----------------------------------------------------------------------------
  const createTable = (design: boolean) => {
    let id = "";
    update((d) => {
      id = newTable(d).id;
    });
    openObject("table", id, design ? "design" : "datasheet");
  };

  const createQuery = () => {
    const id = newId("q");
    update((d) => {
      d.queries.push({ id, name: uniqueObjectName(d, "query", "Query1"), mode: "design", sql: "", design: { tables: [], columns: [] } });
    });
    openObject("query", id, "design");
  };

  const createFromSource = (kind: "form" | "report", source: { kind: "table" | "query"; id: string }) => {
    const src = findObject(doc, source.kind, source.id);
    if (!src) return;
    const columns =
      source.kind === "table"
        ? doc.tables.find((t) => t.id === source.id)!.fields.map((f) => f.name)
        : [];
    const id = newId(kind === "form" ? "fm" : "rp");
    update((d) => {
      const name = uniqueObjectName(d, kind, src.name);
      if (kind === "form") d.forms.push({ id, name, title: src.name, source, columns });
      else d.reports.push({ id, name, title: src.name, source, columns });
    });
    // Query columns are only known after running it; let design view fill them in.
    openObject(kind, id, source.kind === "query" ? "design" : undefined);
    if (source.kind === "query") setStatus(`Tick the fields to show on the ${kind}, then switch to ${kind === "form" ? "Form" : "Report"} View.`);
  };

  const createFormOrReport = (kind: "form" | "report") => {
    if (selection && (selection.kind === "table" || selection.kind === "query")) {
      createFromSource(kind, selection as { kind: "table" | "query"; id: string });
    } else if (!doc.tables.length && !doc.queries.length) {
      dialogs.alert("Microsoft Access Web", `Create a table first, then make a ${kind} from it.`);
    } else setSourcePicker(kind);
  };

  const exportAccess = async () => {
    setStatus("Preparing your Access database…");
    try {
      await save();
      if (docRef.current !== savedDoc.current) await save();
      await api.downloadAccdb(props.project.id, name);
      setStatus(`Exported ${name}.accdb. Saved queries are listed in the _SavedQueries table.`);
    } catch (e) {
      setStatus((e as Error).message, "error");
      dialogs.alert("Export to Access", `The export didn't work: ${(e as Error).message}`);
    }
  };

  const renameDatabase = async () => {
    const next = await dialogs.prompt("Rename Database", "Database name:", name, (v) =>
      validateObjectName({ version: 1, tables: [], queries: [], forms: [], reports: [], relationships: [] }, "table", v),
    );
    if (!next || next === name) return;
    try {
      await save();
      const res = await api.saveProject(props.project.id, revision.current, { name: next });
      revision.current = res.project.revision;
      setName(next);
    } catch (e) {
      setStatus((e as Error).message, "error");
    }
  };

  const reloadFromServer = async () => {
    const { project } = await api.getProject(props.project.id);
    revision.current = project.revision;
    savedDoc.current = project.doc;
    docRef.current = project.doc;
    history.current = { past: [], future: [] };
    setDoc(project.doc);
    setName(project.name);
    setSaveState("saved");
    setStatus("Reloaded the latest version.");
  };

  // ---- Keyboard shortcuts --------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      } else if (mod && !typing && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && !typing && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (e.key === "F11") {
        e.preventDefault();
        setNavCollapsed((c) => !c);
      } else if (mod && e.key === "F4" && activeKey) {
        e.preventDefault();
        closeTab(activeKey);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, undo, redo, activeKey, closeTab]);

  const saveLabel = { saved: "All changes saved", pending: "Unsaved changes", saving: "Saving…", error: "Not saved — will retry", conflict: "Changed elsewhere" }[saveState];
  const activeCommands = (activeKey && commands.current.get(activeKey)) || {};

  return (
    <WorkspaceContext.Provider value={wsApi}>
      <div className="app-shell">
        <header className="title-bar">
          <div className="qat">
            <AccessIcon size={18} />
            <button className="icon-btn light" title="Save (Ctrl+S)" onClick={save} aria-label="Save"><SaveIcon size={14} /></button>
            <button className="icon-btn light" title="Undo (Ctrl+Z)" onClick={undo} aria-label="Undo"><UndoIcon size={14} /></button>
            <button className="icon-btn light" title="Redo (Ctrl+Y)" onClick={redo} aria-label="Redo"><RedoIcon size={14} /></button>
          </div>
          <div className="title-text">{name} : Database - Access Web</div>
          <div className="title-user" title={props.user.email}>{props.user.name}</div>
        </header>

        <Ribbon
          tab={activeTab}
          commands={activeCommands}
          actions={{
            openBackstage: () => setBackstage(true),
            setView: (v) => activeKey && setTabView(activeKey, v),
            createTable: () => createTable(false),
            createTableDesign: () => createTable(true),
            createQueryDesign: createQuery,
            createForm: () => createFormOrReport("form"),
            createReport: () => createFormOrReport("report"),
            importText: () => setImporting(true),
            exportAccess,
            openRelationships: () => openObject("relationships", "main"),
            refresh: () => setRefreshKey((k) => k + 1),
          }}
        />

        {saveState === "conflict" && (
          <div className="message-bar">
            <strong>Changed elsewhere.</strong> This database was edited in another window, so your latest changes weren't saved.
            <button onClick={reloadFromServer}>Reload latest</button>
          </div>
        )}

        <div className="main-area">
          <NavPane selection={selection} onSelect={setSelection} collapsed={navCollapsed} onToggle={() => setNavCollapsed((c) => !c)} />
          <section className="document-area">
            {tabs.length > 0 && (
              <div className="doc-tabs" role="tablist">
                {tabs.map((t) => {
                  const obj = t.kind === "relationships" ? { name: "Relationships" } : findObject(doc, t.kind, t.id);
                  const Icon = t.kind === "relationships" ? RelationshipsIcon : OBJECT_ICONS[t.kind];
                  return (
                    <div key={t.key} role="tab" aria-selected={t.key === activeKey} className={`doc-tab ${t.key === activeKey ? "active" : ""}`} onMouseDown={() => setActiveKey(t.key)} onAuxClick={(e) => e.button === 1 && closeTab(t.key)}>
                      <Icon size={14} />
                      <span>{obj?.name ?? "?"}</span>
                      <button className="icon-btn tab-close" aria-label={`Close ${obj?.name}`} onMouseDown={(e) => e.stopPropagation()} onClick={() => closeTab(t.key)}>
                        <CloseIcon size={9} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="doc-body">
              {tabs.map((t) => (
                <div key={t.key} className="doc-pane" hidden={t.key !== activeKey}>
                  {t.key === activeKey && <TabContent tab={t} refreshKey={refreshKey} />}
                </div>
              ))}
              {!tabs.length && <EmptyWorkspace onCreateTable={() => createTable(false)} onImport={() => setImporting(true)} />}
            </div>
          </section>
        </div>

        <footer className={`status-bar ${status.kind === "error" ? "error" : ""}`}>
          <span className="status-msg" role="status">{status.message}</span>
          <span className={`save-state ${saveState}`}>{saveLabel}</span>
          {activeTab && (
            <span className="status-views">
              {viewsFor(activeTab.kind).map((v) => (
                <button key={v.view} className={v.view === activeTab.view ? "on" : ""} title={v.label} onClick={() => setTabView(activeTab.key, v.view)}>
                  {v.label.replace(" View", "")}
                </button>
              ))}
            </span>
          )}
        </footer>

        {backstage && (
          <Backstage
            name={name}
            doc={doc}
            user={props.user}
            onBack={() => setBackstage(false)}
            onRename={renameDatabase}
            onExport={exportAccess}
            onClose={async () => {
              await save();
              if (docRef.current !== savedDoc.current && !(await dialogs.confirm("Close", "Some changes haven't been saved yet. Close anyway?", { okLabel: "Close" }))) return;
              props.onClose();
            }}
            onSignOut={async () => {
              await save();
              props.onSignOut();
            }}
          />
        )}
        {importing && <ImportCsvDialog onClose={() => setImporting(false)} />}
        {sourcePicker && (
          <SourcePicker
            kind={sourcePicker}
            doc={doc}
            onClose={() => setSourcePicker(null)}
            onPick={(s) => {
              setSourcePicker(null);
              createFromSource(sourcePicker, s);
            }}
          />
        )}
      </div>
    </WorkspaceContext.Provider>
  );
}

function TabContent({ tab, refreshKey }: { tab: Tab; refreshKey: number }) {
  const ws = useWorkspaceDoc();
  if (tab.kind === "relationships") return <RelationshipsView tabKey={tab.key} />;
  const obj = findObject(ws.doc, tab.kind, tab.id);
  if (!obj) return null;
  const key = `${tab.view}:${refreshKey}`;
  switch (tab.kind) {
    case "table": {
      const t = ws.doc.tables.find((x) => x.id === tab.id)!;
      return tab.view === "design" ? <TableDesign key={key} table={t} tabKey={tab.key} /> : <TableDatasheet key={key} table={t} tabKey={tab.key} />;
    }
    case "query": {
      const q = ws.doc.queries.find((x) => x.id === tab.id)!;
      if (tab.view === "design") return <QueryDesignView key={key} query={q} tabKey={tab.key} />;
      if (tab.view === "sql") return <QuerySqlView key={key} query={q} tabKey={tab.key} />;
      return <QueryDatasheet key={key} query={q} tabKey={tab.key} />;
    }
    case "form": {
      const f = ws.doc.forms.find((x) => x.id === tab.id)!;
      return tab.view === "design" ? <FormReportDesign key={key} kind="form" obj={f} /> : <FormView key={key} form={f} tabKey={tab.key} />;
    }
    case "report": {
      const r = ws.doc.reports.find((x) => x.id === tab.id)!;
      return tab.view === "design" ? <FormReportDesign key={key} kind="report" obj={r} /> : <ReportView key={key} report={r} tabKey={tab.key} />;
    }
  }
}

function EmptyWorkspace({ onCreateTable, onImport }: { onCreateTable: () => void; onImport: () => void }) {
  return (
    <div className="empty-workspace">
      <p>Open an object from the Navigation Pane, or get started:</p>
      <div className="button-row">
        <button onClick={onCreateTable}>Create a table</button>
        <button onClick={onImport}>Import a CSV file</button>
      </div>
    </div>
  );
}

function SourcePicker(props: {
  kind: "form" | "report";
  doc: ProjectDoc;
  onClose: () => void;
  onPick: (s: { kind: "table" | "query"; id: string }) => void;
}) {
  const options = [
    ...props.doc.tables.map((t) => ({ kind: "table" as const, id: t.id, name: t.name })),
    ...props.doc.queries.map((q) => ({ kind: "query" as const, id: q.id, name: q.name })),
  ];
  const [picked, setPicked] = useState(options[0]);
  return (
    <Modal
      title={`New ${KIND_LABEL[props.kind]}`}
      onClose={props.onClose}
      width={360}
      footer={
        <>
          <button className="primary" disabled={!picked} onClick={() => picked && props.onPick(picked)}>OK</button>
          <button onClick={props.onClose}>Cancel</button>
        </>
      }
    >
      <p>Choose the table or query where the object's data comes from:</p>
      <div className="list-box">
        {options.map((o) => {
          const Icon = OBJECT_ICONS[o.kind as ObjectKind];
          return (
            <div
              key={o.id}
              className={`list-item ${picked?.id === o.id ? "selected" : ""}`}
              onClick={() => setPicked(o)}
              onDoubleClick={() => props.onPick(o)}
            >
              <Icon /> {o.name}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

function Backstage(props: {
  name: string;
  doc: ProjectDoc;
  user: UserInfo;
  onBack: () => void;
  onRename: () => void;
  onExport: () => void;
  onClose: () => void;
  onSignOut: () => void;
}) {
  const records = props.doc.tables.reduce((n, t) => n + t.rows.length, 0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onBack();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);
  return (
    <div className="backstage">
      <nav className="backstage-nav">
        <button className="backstage-back" onClick={props.onBack} aria-label="Back">
          <BackIcon size={28} />
        </button>
        <button className="active">Info</button>
        <button onClick={props.onExport}>Export to Access</button>
        <button onClick={props.onClose}>Close</button>
        <div className="spacer" />
        <button onClick={props.onSignOut}>Sign out</button>
      </nav>
      <main className="backstage-main">
        <h1>Info</h1>
        <h2>{props.name}</h2>
        <div className="info-cards">
          <div className="info-card">
            <h3>Database</h3>
            <p>
              {props.doc.tables.length} table(s), {props.doc.queries.length} queries, {props.doc.forms.length} form(s),{" "}
              {props.doc.reports.length} report(s), {records.toLocaleString()} record(s).
            </p>
            <button onClick={props.onRename}>Rename database…</button>
          </div>
          <div className="info-card">
            <h3>Export to Microsoft Access</h3>
            <p>
              Download a <strong>.accdb</strong> file that opens in Access 2007 and later. Tables, data, primary keys, indexes and
              relationships are included. Saved queries are listed with their SQL in a table called <code>_SavedQueries</code>; forms
              and reports stay here because the Access file format for them isn't publicly writable.
            </p>
            <button className="primary" onClick={props.onExport}>Export .accdb</button>
          </div>
          <div className="info-card">
            <h3>Account</h3>
            <p>
              Signed in as <strong>{props.user.name}</strong> ({props.user.email}). Your databases save automatically to your account.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
