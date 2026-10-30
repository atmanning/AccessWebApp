import { produce } from "immer";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionInfo, ObjectKind, ProjectDoc, ProjectRecord, RemoteTableInfo, UserInfo } from "../../../shared/model";
import { api, ApiError } from "../api";
import { Modal, showImportWarnings, useDialogs } from "../ui/dialogs";
import { dateShortcut, insertAtCaret, isTextBox, nowText } from "../ui/dateKeys";
import { mergeProjects } from "../../../shared/exchange";
import { AccessIcon, BackIcon, CloseIcon, OBJECT_ICONS, RedoIcon, RelationshipsIcon, SaveIcon, UndoIcon, ConsoleIcon } from "../ui/icons";
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
import { ShareDialog } from "./ShareDialog";
import { ConnectionDialog, ConnectionsManager, RemoteTablesDialog } from "./ConnectionDialogs";
import { OtherDatabaseDialog, type OtherDbMode } from "./OtherDatabaseDialog";
import { copyObject, PasteDialog, readClipboard, type ClipItem } from "./clipboard";
import { LinkedTableView, SqlConsoleView } from "../views/RemoteViews";
import { cleanName } from "../../../shared/exchange";
import { QUERY_TYPE_ICONS, typeOfQuery } from "./queryKinds";
import { NavPane, type Selection } from "./NavPane";
import { Ribbon } from "./Ribbon";

type SaveState = "saved" | "pending" | "saving" | "error" | "conflict";
const MAX_UNDO = 100;

export function Workspace(props: {
  project: ProjectRecord;
  user: UserInfo;
  onClose: () => void;
  onSignOut: () => void;
  /** Opens another database (used by Save a copy). */
  onOpenProject: (p: ProjectRecord) => void;
}) {
  const role = props.project.role;
  const readOnly = role === "view";
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
  // Saved MySQL connections for this database (loaded once, refreshed after changes).
  const [connections, setConnections] = useState<ConnectionInfo[] | null>(null);
  const [mysqlDialog, setMysqlDialog] = useState<"manage" | "link" | "import" | "new" | null>(null);
  const refreshConnections = useCallback(async () => {
    try {
      setConnections((await api.listConnections(props.project.id)).connections);
    } catch {
      setConnections([]);
    }
  }, [props.project.id]);
  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections]);
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
    if (readOnly) {
      setStatus("You have view-only access to this database. Use Save a copy to make your own editable version.", "error");
      return;
    }
    const prev = docRef.current;
    const next = produce(prev, recipe);
    if (next === prev) return;
    history.current.past.push(prev);
    if (history.current.past.length > MAX_UNDO) history.current.past.shift();
    history.current.future = [];
    docRef.current = next;
    setDoc(next);
  }, [readOnly, setStatus]);

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
    if (kind !== "relationships" && kind !== "console") setSelection({ kind, id });
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
    const before = signature(commands.current.get(key));
    if (cmds) commands.current.set(key, cmds);
    else commands.current.delete(key);
    // Redraw the ribbon only when what it shows changes (which buttons are enabled, pressed states).
    if (signature(cmds ?? undefined) !== before) forceRibbon((n) => n + 1);
  }, []);

  // Close tabs whose objects were deleted (e.g. by undo of a create).
  useEffect(() => {
    setTabs((ts) => {
      const alive = ts.filter((t) => t.kind === "relationships" || t.kind === "console" || findObject(doc, t.kind, t.id));
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
      readOnly,
      connections,
      refreshConnections,
    }),
    [props.project.id, name, doc, update, openObject, closeTab, setTabView, activeKey, setStatus, registerCommands, readOnly, connections, refreshConnections],
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

  const accessInput = useRef<HTMLInputElement>(null);

  /** External Data > Access: adds another Access file's tables and queries to this database. */
  const importAccessFile = async (file: File) => {
    setStatus(`Reading ${file.name}…`);
    try {
      const { doc: incoming, warnings } = await api.convertAccess(file);
      const records = incoming.tables.reduce((n, t) => n + t.rows.length, 0);
      if (!incoming.tables.length && !incoming.queries.length) {
        setStatus("");
        await showImportWarnings(dialogs, warnings, `Nothing in ${file.name} could be imported.`);
        return;
      }
      const ok = await dialogs.confirm(
        "Get External Data - Access Database",
        <>
          <p>
            Import {incoming.tables.length} table(s) with {records.toLocaleString()} record(s), {incoming.queries.length} query(ies) and{" "}
            {incoming.relationships.length} relationship(s) from <strong>{file.name}</strong> into this database?
          </p>
          {incoming.tables.length > 0 && <p className="small muted">Tables: {incoming.tables.map((t) => t.name).join(", ")}</p>}
          <p className="small muted">Objects whose names are already used here get a number added, as in Access.</p>
        </>,
        { okLabel: "Import" },
      );
      if (!ok) return setStatus("");
      const { doc: merged, renamed } = mergeProjects(docRef.current, incoming);
      update((d) => {
        d.tables = merged.tables;
        d.queries = merged.queries;
        d.relationships = merged.relationships;
      });
      setStatus(`Imported ${incoming.tables.length} table(s) and ${incoming.queries.length} query(ies) from ${file.name}.`);
      const notes = [...renamed.map((r) => `Renamed to avoid a clash: ${r}.`), ...warnings];
      if (notes.length) showImportWarnings(dialogs, notes, "Imported, with these notes:");
    } catch (e) {
      setStatus((e as Error).message, "error");
      dialogs.alert("Get External Data - Access Database", (e as Error).message);
    }
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

  const reloadFromServer = async (message = "Reloaded the latest version.") => {
    const { project } = await api.getProject(props.project.id);
    revision.current = project.revision;
    savedDoc.current = project.doc;
    docRef.current = project.doc;
    history.current = { past: [], future: [] };
    setDoc(project.doc);
    setName(project.name);
    setSaveState("saved");
    setStatus(message);
  };

  // Shared databases: pick up other people's saves. With no unsaved local changes we reload
  // quietly; otherwise the next save reports the conflict and offers a reload.
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      if (document.hidden || saving.current) return;
      try {
        const r = await api.getRevision(props.project.id);
        if (stopped || r.revision <= revision.current) return;
        if (docRef.current === savedDoc.current) {
          await reloadFromServer(r.updatedByName ? `Updated with changes from ${r.updatedByName}.` : "Updated with the latest changes.");
        }
      } catch {
        /* offline or access removed: the next save will say so */
      }
    };
    const timer = setInterval(check, 8000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [props.project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const [sharing, setSharing] = useState(false);

  // ---- MySQL connections ----

  const openConsole = (c?: ConnectionInfo) => {
    const target = c ?? connections?.[0];
    if (!target) {
      setMysqlDialog("new");
      return;
    }
    setMysqlDialog(null);
    openObject("console", target.id);
  };

  const linkTables = (c: ConnectionInfo, tables: RemoteTableInfo[]) => {
    const ids: string[] = [];
    update((d) => {
      d.linkedTables ??= [];
      for (const t of tables) {
        const id = newId("lt");
        ids.push(id);
        d.linkedTables.push({ id, name: uniqueObjectName(d, "linked", cleanName(t.name, "Linked")), connectionId: c.id, remoteTable: t.name });
      }
    });
    setMysqlDialog(null);
    setStatus(`Linked ${tables.length} table(s) from ${c.name}. They're in the Tables group with a link icon.`);
    if (ids.length === 1) openObject("linked", ids[0]);
  };

  const importTables = async (c: ConnectionInfo, tables: RemoteTableInfo[]) => {
    try {
      const { doc: incoming, warnings } = await api.importRemoteTables(props.project.id, c.id, tables.map((t) => t.name));
      const { doc: merged, renamed } = mergeProjects(docRef.current, incoming);
      update((d) => {
        d.tables = merged.tables;
        d.relationships = merged.relationships;
      });
      setMysqlDialog(null);
      const records = incoming.tables.reduce((n, t) => n + t.rows.length, 0);
      setStatus(`Imported ${incoming.tables.length} table(s) with ${records.toLocaleString()} record(s) from ${c.name}.`);
      const notes = [...renamed.map((r) => `Renamed to avoid a clash: ${r}.`), ...warnings];
      if (notes.length) showImportWarnings(dialogs, notes, "Imported, with these notes:");
    } catch (e) {
      dialogs.alert("Import from MySQL", (e as Error).message);
    }
  };

  const [otherDb, setOtherDb] = useState<OtherDbMode | null>(null);

  // ---- Copy / paste ----
  const [pasting, setPasting] = useState<ClipItem | null>(null);
  const copySelected = (kind?: ObjectKind, id?: string) => {
    const target = kind && id ? { kind, id } : selection;
    if (!target) return setStatus("Select a table, query, form or report in the Navigation Pane to copy it.", "error");
    const item = copyObject(docRef.current, props.project.id, target.kind, target.id);
    if (item) setStatus(`Copied ${KIND_LABEL[target.kind].toLowerCase()} '${item.object.name}'. Press Ctrl+V or Paste to paste it, here or in another database.`);
  };
  const paste = () => {
    if (readOnly) return setStatus("You have view-only access to this database.", "error");
    const item = readClipboard();
    if (!item) return setStatus("Nothing to paste. Copy a table, query, form or report first (Ctrl+C).", "error");
    setPasting(item);
  };

  const saveCopy = async () => {
    const copyName = await dialogs.prompt("Save a copy", "Name for your copy:", `${name} (copy)`.slice(0, 64), (v) =>
      validateObjectName({ version: 1, tables: [], queries: [], forms: [], reports: [], relationships: [] }, "table", v),
    );
    if (!copyName) return;
    try {
      await save();
      const { project } = await api.copyProject(props.project.id, copyName);
      props.onOpenProject(project);
      setStatus(`This is your own copy, "${copyName}". You can edit it.`);
    } catch (e) {
      dialogs.alert("Save a copy", (e as Error).message);
    }
  };

  // ---- Keyboard shortcuts --------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      const mod = e.ctrlKey || e.metaKey;
      // Ctrl+; / Ctrl+Shift+; in any text box (forms, criteria, properties). Datasheets handle their own.
      const shortcut = dateShortcut(e);
      if (shortcut && !e.defaultPrevented) {
        if (isTextBox(target)) {
          e.preventDefault();
          // Form controls say whether their field can hold a date (Number, Currency can't).
          if (target.dataset.acceptsDate === "false") setStatus(`This field can't hold a ${shortcut}.`, "error");
          else insertAtCaret(target, nowText(shortcut));
        }
        return;
      }
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
  // Ribbon buttons call the view's latest handler, so they always see current state.
  const activeCommands = liveCommands(commands.current, activeKey);

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
          <div className="title-text">
            {name} : Database{readOnly ? " (Read-Only)" : ""} - Access Web
          </div>
          {role === "owner" ? (
            <button className="title-share" onClick={() => setSharing(true)} title="Share this database with other people">
              Share
            </button>
          ) : (
            <button className="title-share" onClick={saveCopy} title="Make your own copy of this database">
              Save a copy
            </button>
          )}
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
            importAccess: () => accessInput.current?.click(),
            copy: selection ? () => copySelected() : undefined,
            paste: readOnly ? undefined : paste,
            mysqlConnections: () => setMysqlDialog("manage"),
            mysqlLink: readOnly ? undefined : () => setMysqlDialog(connections?.length ? "link" : "new"),
            mysqlImport: readOnly ? undefined : () => setMysqlDialog(connections?.length ? "import" : "new"),
            mysqlConsole: readOnly ? undefined : () => openConsole(),
            otherDbImport: readOnly ? undefined : () => setOtherDb("import"),
            otherDbLink: readOnly ? undefined : () => setOtherDb("link"),
            exportAccess,
            openRelationships: () => openObject("relationships", "main"),
            refresh: () => setRefreshKey((k) => k + 1),
          }}
        />

        {saveState === "conflict" && (
          <div className="message-bar">
            <strong>Changed elsewhere.</strong> {status.kind === "error" ? status.message : "This database was changed elsewhere."} Your
            latest changes weren't saved.
            <button onClick={() => reloadFromServer()}>Reload latest</button>
          </div>
        )}
        {readOnly && (
          <div className="message-bar readonly-bar">
            <strong>Read-only.</strong> {props.project.ownerName} shared this database with you to view. You can run queries and export it.
            <button onClick={saveCopy}>Save a copy</button>
          </div>
        )}

        <div className="main-area">
          <NavPane
            selection={selection}
            onSelect={setSelection}
            collapsed={navCollapsed}
            onToggle={() => setNavCollapsed((c) => !c)}
            onCopy={copySelected}
            onPaste={paste}
          />
          <section className="document-area">
            {tabs.length > 0 && (
              <div className="doc-tabs" role="tablist">
                {tabs.map((t) => {
                  const obj =
                    t.kind === "relationships"
                      ? { name: "Relationships" }
                      : t.kind === "console"
                        ? { name: `SQL: ${connections?.find((c) => c.id === t.id)?.name ?? "MySQL"}` }
                        : findObject(doc, t.kind, t.id);
                  const q = t.kind === "query" ? doc.queries.find((x) => x.id === t.id) : undefined;
                  const Icon =
                    t.kind === "relationships" ? RelationshipsIcon : t.kind === "console" ? ConsoleIcon : q ? QUERY_TYPE_ICONS[typeOfQuery(q)] : OBJECT_ICONS[t.kind];
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
            onRename={role === "owner" ? renameDatabase : undefined}
            onShare={role === "owner" ? () => { setBackstage(false); setSharing(true); } : undefined}
            onCopy={saveCopy}
            roleText={
              role === "owner"
                ? "You own this database."
                : `${props.project.ownerName} shared this database with you. You can ${role === "edit" ? "view and edit" : "view"} it.`
            }
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
        {pasting && <PasteDialog item={pasting} onClose={() => setPasting(null)} />}
        {mysqlDialog === "manage" && <ConnectionsManager onClose={() => setMysqlDialog(null)} onOpenConsole={openConsole} />}
        {mysqlDialog === "new" && (
          <ConnectionDialog
            onClose={() => setMysqlDialog(null)}
            onSaved={async (c) => {
              setMysqlDialog(null);
              await refreshConnections();
              setStatus(`Saved connection ${c.name}.`);
            }}
          />
        )}
        {(mysqlDialog === "link" || mysqlDialog === "import") && (
          <RemoteTablesDialog
            mode={mysqlDialog}
            onClose={() => setMysqlDialog(null)}
            onNewConnection={() => setMysqlDialog("new")}
            onDone={(c, tables) => (mysqlDialog === "link" ? linkTables(c, tables) : importTables(c, tables))}
          />
        )}
        {otherDb && (
          <OtherDatabaseDialog
            mode={otherDb}
            onClose={() => setOtherDb(null)}
            onDone={(message, notes) => {
              setOtherDb(null);
              setStatus(message);
              if (notes.length) showImportWarnings(dialogs, notes, "Done, with these notes:");
            }}
          />
        )}
        {sharing && <ShareDialog projectId={props.project.id} projectName={name} owner={props.user} onClose={() => setSharing(false)} />}
        <input
          ref={accessInput}
          type="file"
          accept=".accdb,.mdb,.accde,.mde"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) importAccessFile(f);
          }}
        />
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

/** Which commands exist and their displayed state; changes here redraw the ribbon. */
function signature(c: ViewCommands | undefined): string {
  if (!c) return "";
  const present = Object.entries(c).filter(([, v]) => typeof v === "function").map(([k]) => k).sort();
  return JSON.stringify([present, c.queryType ?? null, c.totals ?? null]);
}

function liveCommands(all: Map<string, ViewCommands>, key: string | null): ViewCommands {
  const current = (key && all.get(key)) || {};
  const live: Record<string, unknown> = { queryType: current.queryType, totals: current.totals };
  for (const [name, value] of Object.entries(current)) {
    if (typeof value === "function") {
      live[name] = (...args: unknown[]) => {
        const latest = key ? (all.get(key) as Record<string, unknown> | undefined)?.[name] : undefined;
        return typeof latest === "function" ? latest(...args) : undefined;
      };
    }
  }
  return live as ViewCommands;
}

function TabContent({ tab, refreshKey }: { tab: Tab; refreshKey: number }) {
  const ws = useWorkspaceDoc();
  if (tab.kind === "relationships") return <RelationshipsView tabKey={tab.key} />;
  if (tab.kind === "console") return <SqlConsoleView connectionId={tab.id} tabKey={tab.key} />;
  const obj = findObject(ws.doc, tab.kind, tab.id);
  if (!obj) return null;
  const key = `${tab.view}:${refreshKey}`;
  switch (tab.kind) {
    case "linked":
      return <LinkedTableView key={key} link={ws.doc.linkedTables!.find((x) => x.id === tab.id)!} tabKey={tab.key} />;
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
  onRename?: () => void;
  onShare?: () => void;
  onCopy: () => void;
  roleText: string;
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
        {props.onShare && <button onClick={props.onShare}>Share</button>}
        <button onClick={props.onCopy}>Save a copy</button>
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
            <p>{props.roleText}</p>
            <div className="button-row">
              {props.onRename && <button onClick={props.onRename}>Rename database…</button>}
              {props.onShare && <button onClick={props.onShare}>Share…</button>}
              <button onClick={props.onCopy}>Save a copy…</button>
            </div>
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
