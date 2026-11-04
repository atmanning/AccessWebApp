import { produce } from "immer";
import { LayoutPicker } from "../ui/LayoutPicker";
import { useLayout, useLongPress } from "../ui/layout";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionInfo, LinkedTable, ObjectKind, ProjectDoc, ProjectRecord, RemoteForeignKey, RemoteTableInfo, UserInfo } from "../../../shared/model";
import { linkedRelations } from "../engine/queryDesign";
import { api, ApiError } from "../api";
import { Modal, showImportWarnings, useDialogs } from "../ui/dialogs";
import { dateShortcut, insertAtCaret, isTextBox, nowText } from "../ui/dateKeys";
import { mergeProjects } from "../../../shared/exchange";
import { MenuIcon, AccessIcon, BackIcon, CloseIcon, OBJECT_ICONS, RedoIcon, RelationshipsIcon, SaveIcon, UndoIcon, ConsoleIcon } from "../ui/icons";
import { FormReportDesign, ReportView } from "../views/FormReportViews";
import { FormRunView } from "../forms/FormRunView";
import { FormDesigner } from "../forms/FormDesigner";
import { autoLayout } from "../forms/formLayout";
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
import { setPublicViewing } from "../engine/linked";
import { VersionStamp } from "../ui/VersionStamp";
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
  // Opened through its public link: view only, with exporting, copying and saving a copy turned off.
  const publicView = !!props.project.publicView;
  const guest = !props.user.id;
  setPublicViewing(publicView);
  const dialogs = useDialogs();
  const [doc, setDoc] = useState<ProjectDoc>(props.project.doc);
  const [name, setName] = useState(props.project.name);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [navCollapsed, setNavCollapsed] = useState(false);
  // Phone layout: the navigation pane is a drawer that closes once something is opened.
  const { compact } = useLayout();
  const compactRef = useRef(compact);
  compactRef.current = compact;
  const [status, setStatusState] = useState<{ message: string; kind: StatusKind }>({ message: "Ready", kind: "info" });
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [backstage, setBackstage] = useState(false);
  const [importing, setImporting] = useState(false);
  const [sourcePicker, setSourcePicker] = useState<"form" | "report" | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Saved MySQL connections for this database (loaded once, refreshed after changes).
  const [connections, setConnections] = useState<ConnectionInfo[] | null>(null);
  const [mysqlDialog, setMysqlDialog] = useState<"manage" | "link" | "import" | "new" | null>(null);
  // Which connection the Link/Import Tables dialog starts on, and where a new connection leads next.
  const [mysqlConn, setMysqlConn] = useState<string | undefined>(undefined);
  const [afterNewConn, setAfterNewConn] = useState<"link" | "import" | null>(null);
  const showRemoteTables = (mode: "link" | "import", connectionId?: string) => {
    setMysqlConn(connectionId);
    setMysqlDialog(mode);
  };
  const refreshConnections = useCallback(async () => {
    if (publicView) return setConnections([]); // connection details aren't public
    try {
      setConnections((await api.listConnections(props.project.id)).connections);
    } catch {
      setConnections([]);
    }
  }, [props.project.id, publicView]);
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
    if (compactRef.current) setNavCollapsed(true);
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
      if (kind === "form") {
        // Table forms get their designed layout now; query forms get one from the query's fields when first opened.
        const t = source.kind === "table" ? d.tables.find((x) => x.id === source.id) : undefined;
        const layout = t ? autoLayout(src.name, t.fields.map((f) => ({ name: f.name, field: f }))) : undefined;
        d.forms.push({ id, name, title: src.name, source, columns, ...(layout ? { layout } : {}) });
      } else d.reports.push({ id, name, title: src.name, source, columns });
    });
    // Query columns are only known after running it; let report design view fill them in.
    openObject(kind, id, source.kind === "query" && kind === "report" ? "design" : undefined);
    if (source.kind === "query" && kind === "report") setStatus("Tick the fields to show on the report, then switch to Report View.");
    else if (kind === "form") setStatus("Form created. Switch to Design View to move fields, add buttons and pick a theme.");
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
    const { project } = publicView ? await api.getPublicProject(props.project.id) : await api.getProject(props.project.id);
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
        const r = publicView ? await api.getPublicRevision(props.project.id) : await api.getRevision(props.project.id);
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

  const linkTables = async (c: ConnectionInfo, tables: RemoteTableInfo[]) => {
    // Their foreign keys come too, so Query Design joins linked tables like related ones.
    const fks = await api.remoteForeignKeys(props.project.id, c.id).then((r) => r.foreignKeys, () => null);
    const ids: string[] = [];
    update((d) => {
      d.linkedTables ??= [];
      for (const t of tables) {
        const id = newId("lt");
        ids.push(id);
        d.linkedTables.push({
          id,
          name: uniqueObjectName(d, "linked", cleanName(t.name, "Linked")),
          connectionId: c.id,
          remoteTable: t.name,
          ...(fks ? { foreignKeys: foreignKeysOf(fks, t.name) } : {}),
        });
      }
    });
    setMysqlDialog(null);
    const related = fks ? linkedRelations(docRef.current).filter((r) => ids.some((id) => docRef.current.linkedTables?.find((l) => l.id === id && (l.name === r.fromTable || l.name === r.toTable)))).length : 0;
    setStatus(
      `Linked ${tables.length} table(s) from ${c.name}. They're in the Tables group with a link icon.` +
        (related ? " Their foreign keys join them automatically in Query Design." : fks ? "" : " (Their foreign keys couldn't be read.)"),
    );
    if (ids.length === 1) openObject("linked", ids[0]);
  };

  // Tables linked before foreign keys were read: read them once, quietly (not an undo step).
  useEffect(() => {
    if (readOnly || publicView || !connections) return;
    const pending = [...new Set((doc.linkedTables ?? []).filter((l) => l.connectionId && l.remoteTable && !l.foreignKeys).map((l) => l.connectionId!))];
    const known = pending.filter((cid) => connections.some((c) => c.id === cid && c.database));
    if (!known.length) return;
    let cancelled = false;
    void (async () => {
      for (const cid of known) {
        const fks = await api.remoteForeignKeys(props.project.id, cid).then((r) => r.foreignKeys, () => null);
        if (cancelled || !fks) continue;
        const next = produce(docRef.current, (d) => {
          for (const l of d.linkedTables ?? []) if (l.connectionId === cid && l.remoteTable && !l.foreignKeys) l.foreignKeys = foreignKeysOf(fks, l.remoteTable);
        });
        if (next === docRef.current) continue;
        // Keep undo history pointing at documents that already have them, so undo doesn't drop them.
        history.current.past = history.current.past.map((p) =>
          produce(p, (d) => {
            for (const l of d.linkedTables ?? []) if (l.connectionId === cid && l.remoteTable && !l.foreignKeys) l.foreignKeys = foreignKeysOf(fks, l.remoteTable);
          }),
        );
        docRef.current = next;
        setDoc(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connections, (doc.linkedTables ?? []).map((l) => `${l.id}:${!!l.foreignKeys}`).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (publicView) return setStatus("Copying is turned off for this public database.", "error");
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
  const live = liveCommands(commands.current, activeKey);
  const activeCommands = publicView ? { ...live, exportText: undefined, print: live.print } : live;

  return (
    <WorkspaceContext.Provider value={wsApi}>
      <div className="app-shell">
        <header className="title-bar">
          <div className="qat">
            {compact ? (
              <button className="icon-btn light nav-burger" onClick={() => setNavCollapsed((c) => !c)} aria-label={navCollapsed ? "Show objects" : "Hide objects"} aria-expanded={!navCollapsed}>
                <MenuIcon size={18} />
              </button>
            ) : (
              <AccessIcon size={18} />
            )}
            {!compact && <button className="icon-btn light" title="Save (Ctrl+S)" onClick={save} aria-label="Save"><SaveIcon size={14} /></button>}
            <button className="icon-btn light" title="Undo (Ctrl+Z)" onClick={undo} aria-label="Undo"><UndoIcon size={14} /></button>
            <button className="icon-btn light" title="Redo (Ctrl+Y)" onClick={redo} aria-label="Redo"><RedoIcon size={14} /></button>
          </div>
          <div className="title-text">
            {compact ? <>{name}{readOnly ? " (Read-Only)" : ""}</> : <>{name} : Database{readOnly ? " (Read-Only)" : ""} - Access Web</>}
          </div>
          {role === "owner" ? (
            <button className="title-share" onClick={() => setSharing(true)} title="Share this database with other people">
              Share
            </button>
          ) : publicView ? (
            guest && (
              <button className="title-share" onClick={props.onSignOut} title="Sign in or create an account">
                Sign in
              </button>
            )
          ) : (
            <button className="title-share" onClick={saveCopy} title="Make your own copy of this database">
              Save a copy
            </button>
          )}
          <div className="title-user" title={props.user.email}>{props.user.name}</div>
          <VersionStamp className="title-version" />
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
            importText: publicView ? undefined : () => setImporting(true),
            importAccess: publicView ? undefined : () => accessInput.current?.click(),
            copy: selection && !publicView ? () => copySelected() : undefined,
            paste: readOnly ? undefined : paste,
            mysqlConnections: publicView ? undefined : () => setMysqlDialog("manage"),
            mysqlLink: readOnly ? undefined : () => (connections?.length ? showRemoteTables("link") : (setAfterNewConn("link"), setMysqlDialog("new"))),
            mysqlImport: readOnly ? undefined : () => (connections?.length ? showRemoteTables("import") : (setAfterNewConn("import"), setMysqlDialog("new"))),
            mysqlConsole: readOnly ? undefined : () => openConsole(),
            otherDbImport: readOnly ? undefined : () => setOtherDb("import"),
            otherDbLink: readOnly ? undefined : () => setOtherDb("link"),
            exportAccess: publicView ? undefined : exportAccess,
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
        {publicView && (
          <div className="message-bar readonly-bar">
            <strong>Public view.</strong> {props.project.ownerName} published this database for anyone with the link to view. You can
            browse it and run its queries, forms and reports; exporting and copying are turned off.
            {guest && <button onClick={props.onSignOut}>Sign in</button>}
          </div>
        )}
        {readOnly && !publicView && (
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
            onCopy={publicView ? undefined : saveCopy}
            guest={guest}
            roleText={
              role === "owner"
                ? "You own this database."
                : publicView
                  ? `${props.project.ownerName} published this database for anyone with the link to view. Exporting and copying are turned off.`
                  : `${props.project.ownerName} shared this database with you. You can ${role === "edit" ? "view and edit" : "view"} it.`
            }
            onExport={publicView ? undefined : exportAccess}
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
        {mysqlDialog === "manage" && (
          <ConnectionsManager onClose={() => setMysqlDialog(null)} onOpenConsole={openConsole} onTables={(c, mode) => showRemoteTables(mode, c.id)} />
        )}
        {mysqlDialog === "new" && (
          <ConnectionDialog
            onClose={() => (setMysqlDialog(null), setAfterNewConn(null))}
            onSaved={async (c) => {
              await refreshConnections();
              setStatus(`Saved connection ${c.name}.`);
              // Started from Link Tables or Import Tables: carry on to the table list.
              if (afterNewConn) showRemoteTables(afterNewConn, c.id);
              else setMysqlDialog(null);
              setAfterNewConn(null);
            }}
          />
        )}
        {(mysqlDialog === "link" || mysqlDialog === "import") && (
          <RemoteTablesDialog
            mode={mysqlDialog}
            onClose={() => setMysqlDialog(null)}
            connectionId={mysqlConn}
            onNewConnection={() => (setAfterNewConn(mysqlDialog), setMysqlDialog("new"))}
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
  const f = c.formDesign;
  const form = f ? [f.tool, f.selectionCount, f.theme, f.fieldList, f.propertySheet] : null;
  return JSON.stringify([present, c.queryType ?? null, c.totals ?? null, form]);
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
  // Form Design: the state the ribbon shows, with handlers that call the view's latest ones.
  if (current.formDesign) {
    const fd: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(current.formDesign)) {
      fd[name] =
        typeof value === "function"
          ? (...args: unknown[]) => {
              const latest = key ? (all.get(key)?.formDesign as Record<string, unknown> | undefined)?.[name] : undefined;
              return typeof latest === "function" ? latest(...args) : undefined;
            }
          : value;
    }
    live.formDesign = fd;
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
      return tab.view === "design" ? <FormDesigner key={key} form={f} tabKey={tab.key} /> : <FormRunView key={key} form={f} tabKey={tab.key} />;
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
  onCopy?: () => void;
  roleText: string;
  onExport?: () => void;
  guest?: boolean;
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
        {props.onCopy && <button onClick={props.onCopy}>Save a copy</button>}
        {props.onExport && <button onClick={props.onExport}>Export to Access</button>}
        {!props.guest && <button onClick={props.onClose}>Close</button>}
        <div className="spacer" />
        <LayoutPicker className="backstage-layout" />
        <button onClick={props.onSignOut}>{props.guest ? "Sign in" : "Sign out"}</button>
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
            <p className="small muted">
              Access Web version: <VersionStamp />
            </p>
            <div className="button-row">
              {props.onRename && <button onClick={props.onRename}>Rename database…</button>}
              {props.onShare && <button onClick={props.onShare}>Share…</button>}
              {props.onCopy && <button onClick={props.onCopy}>Save a copy…</button>}
            </div>
          </div>
          {props.onExport && (
          <div className="info-card">
            <h3>Export to Microsoft Access</h3>
            <p>
              Download a <strong>.accdb</strong> file that opens in Access 2007 and later. Tables, data, primary keys, indexes and
              relationships are included. Saved queries are listed with their SQL in a table called <code>_SavedQueries</code>; forms
              and reports stay here because the Access file format for them isn't publicly writable.
            </p>
            <button className="primary" onClick={props.onExport}>Export .accdb</button>
          </div>
          )}
          <div className="info-card">
            <h3>Account</h3>
            {props.guest ? (
              <p>You aren't signed in. Sign in or create an account to make and share your own databases.</p>
            ) : (
              <p>
                Signed in as <strong>{props.user.name}</strong> ({props.user.email}). Your databases save automatically to your account.
              </p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/** The foreign keys of one remote table, as stored on its link. */
function foreignKeysOf(all: RemoteForeignKey[], table: string): NonNullable<LinkedTable["foreignKeys"]> {
  return all
    .filter((fk) => fk.table.toLowerCase() === table.toLowerCase())
    .slice(0, 64)
    .map((fk) => ({ name: fk.name.slice(0, 64), refTable: fk.refTable, columns: fk.columns.slice(0, 16) }));
}
