import { useEffect, useRef, useState } from "react";
import { PublicReportDialog } from "../reports/PublicReportDialog";
import { isAppLink, QUERY_TYPE_LABELS, type LinkedTable, type ObjectKind } from "../../../shared/model";
import { isActionType } from "../engine/statements";
import { useDialogs } from "../ui/dialogs";
import { useLayout, useLongPress } from "../ui/layout";
import { ChevronIcon, FindIcon, OBJECT_ICONS } from "../ui/icons";
import { tabKey, useWorkspace } from "./context";
import { deleteObject, dependents, findObject, KIND_LABEL, KIND_PLURAL, objectsOf, renameObject, validateObjectName } from "./docOps";
import { QUERY_TYPE_ICONS, typeOfQuery } from "./queryKinds";
import { useRunAction } from "./useRunAction";

/** Navigation Pane groups. Linked tables are listed with the tables, as in Access. */
const GROUPS: { group: ObjectKind; kinds: ObjectKind[] }[] = [
  { group: "table", kinds: ["table", "linked"] },
  { group: "query", kinds: ["query"] },
  { group: "form", kinds: ["form"] },
  { group: "report", kinds: ["report"] },
];

function linkTitle(l: LinkedTable | undefined) {
  if (!l) return undefined;
  if (isAppLink(l)) return `Linked ${l.sourceKind} '${l.sourceName}' from the database '${l.sourceProjectName}'`;
  return `Linked MySQL table '${l.remoteTable}'`;
}

export type Selection = { kind: ObjectKind; id: string } | null;

/** Queries show their type's icon (select, update, delete, ...). */
function ItemIcon({ kind, id }: { kind: ObjectKind; id: string }) {
  const ws = useWorkspace();
  const Fallback = OBJECT_ICONS[kind];
  if (kind !== "query") return <Fallback />;
  const q = ws.doc.queries.find((x) => x.id === id);
  const Icon = q ? QUERY_TYPE_ICONS[typeOfQuery(q)] : Fallback;
  return <Icon />;
}

/** In-place rename box, like Access's F2 in the Navigation Pane. */
function RenameBox(props: { initial: string; onCommit: (name: string) => boolean; onCancel: () => void }) {
  const [value, setValue] = useState(props.initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    if (done.current) return;
    if (props.onCommit(value.trim())) done.current = true;
    else ref.current?.focus();
  };
  return (
    <input
      ref={ref}
      className="nav-rename"
      value={value}
      maxLength={64}
      aria-label="New name"
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          done.current = true;
          props.onCancel();
        }
      }}
      onBlur={commit}
    />
  );
}

export function NavPane(props: {
  selection: Selection;
  onSelect: (s: Selection) => void;
  collapsed: boolean;
  onToggle: () => void;
  onCopy: (kind: ObjectKind, id: string) => void;
  onPaste: () => void;
}) {
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const runAction = useRunAction();
  const [search, setSearch] = useState("");
  const [closedGroups, setClosedGroups] = useState<Set<ObjectKind>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; kind: ObjectKind; id: string } | null>(null);
  const [renaming, setRenaming] = useState<{ kind: ObjectKind; id: string } | null>(null);
  const [publicReport, setPublicReport] = useState<string | null>(null);
  const { compact, touch } = useLayout();
  const press = useLongPress();
  const menuOpenedAt = useRef(0);
  const openMenu = (x: number, y: number, kind: ObjectKind, id: string) => {
    menuOpenedAt.current = Date.now();
    props.onSelect({ kind, id });
    setMenu({ x, y, kind, id });
  };

  useEffect(() => {
    if (!menu) return;
    // Ignore the mouse event some phones send when a long press ends.
    const close = () => Date.now() - menuOpenedAt.current > 400 && setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  /** Opening an action query runs it (after a warning), as in Access; everything else opens. */
  const openItem = async (kind: ObjectKind, id: string) => {
    const q = kind === "query" ? ws.doc.queries.find((x) => x.id === id) : undefined;
    if (q && isActionType(typeOfQuery(q))) {
      const verb = QUERY_TYPE_LABELS[typeOfQuery(q)].toLowerCase();
      const ok = await dialogs.confirm(
        "Microsoft Access Web",
        `You are about to run a${/^[aeiou]/.test(verb) ? "n" : ""} ${verb} query that will modify data in your database. Are you sure you want to run this type of action query?`,
        { okLabel: "Yes" },
      );
      if (ok) await runAction(q);
      return;
    }
    ws.openObject(kind, id);
  };

  const startRename = (kind: ObjectKind, id: string) => {
    if (ws.readOnly) return ws.setStatus("You have view-only access to this database.", "error");
    setRenaming({ kind, id });
  };

  /** Returns false (and keeps the box open) when the name isn't allowed. */
  const commitRename = (kind: ObjectKind, id: string, name: string): boolean => {
    const obj = findObject(ws.doc, kind, id);
    if (!obj || name === obj.name) {
      setRenaming(null);
      return true;
    }
    const err = validateObjectName(ws.doc, kind, name, id);
    if (err) {
      ws.setStatus(err, "error");
      return false;
    }
    ws.update((d) => renameObject(d, kind, id, name));
    ws.setStatus(`Renamed to '${name}'.`);
    setRenaming(null);
    return true;
  };

  const remove = async (kind: ObjectKind, id: string) => {
    const obj = findObject(ws.doc, kind, id);
    if (!obj) return;
    const deps = dependents(ws.doc, kind, id);
    const ok = await dialogs.confirm(
      "Microsoft Access Web",
      <>
        <p>
          {kind === "linked"
            ? `Do you want to delete the link '${obj.name}'? The linked data itself isn't affected.`
            : `Do you want to delete the ${KIND_LABEL[kind].toLowerCase()} '${obj.name}'?`}
        </p>
        {kind === "table" && <p>Deleting a table also deletes its data and any relationships it has.</p>}
        {deps.length > 0 && <p>These objects use it and will stop working: {deps.join(", ")}.</p>}
      </>,
      { okLabel: "Yes", danger: true },
    );
    if (!ok) return;
    ws.closeTab(tabKey(kind, id));
    ws.update((d) => deleteObject(d, kind, id));
    props.onSelect(null);
  };

  if (props.collapsed && compact) return null;
  if (props.collapsed) {
    return (
      <aside className="nav-pane collapsed" aria-label="Navigation Pane">
        <button className="nav-collapse" onClick={props.onToggle} title="Open the Navigation Pane (F11)">
          <span className="nav-collapsed-label">Navigation Pane</span>
        </button>
      </aside>
    );
  }

  const query = search.trim().toLowerCase();
  const menuQuery = menu?.kind === "query" ? ws.doc.queries.find((x) => x.id === menu.id) : undefined;
  const menuItems = menu
    ? [
        ...(menuQuery && isActionType(typeOfQuery(menuQuery))
          ? [
              { label: "Run", run: () => openItem(menu.kind, menu.id) },
              { label: "Preview (Datasheet View)", run: () => ws.openObject(menu.kind, menu.id, "datasheet") },
            ]
          : [{ label: "Open", run: () => ws.openObject(menu.kind, menu.id) }]),
        ...(menu.kind !== "linked" ? [{ label: "Design View", run: () => ws.openObject(menu.kind, menu.id, "design") }] : []),
        ...(menu.kind === "query" ? [{ label: "SQL View", run: () => ws.openObject(menu.kind, menu.id, "sql") }] : []),
        ...(menu.kind === "report" && ws.signedIn && ws.role === "owner" ? [{ label: "Public Link…", run: () => setPublicReport(menu.id) }] : []),
        { label: "Copy", shortcut: "Ctrl+C", run: () => props.onCopy(menu.kind, menu.id) },
        { label: "Paste", shortcut: "Ctrl+V", run: () => props.onPaste() },
        { label: "Rename", shortcut: "F2", run: () => startRename(menu.kind, menu.id) },
        { label: menu.kind === "linked" ? "Delete link" : "Delete", shortcut: "Del", run: () => remove(menu.kind, menu.id) },
      ]
    : [];

  return (
    <>
    {compact && <div className="nav-backdrop" onClick={props.onToggle} aria-hidden="true" />}
    <aside
      className={`nav-pane ${compact ? "drawer" : ""}`}
      aria-label="Navigation Pane"
      onKeyDown={(e) => {
        // Ctrl+V pastes anywhere in the pane (also when nothing is selected).
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && !(e.target instanceof HTMLInputElement)) {
          e.preventDefault();
          props.onPaste();
        }
      }}
    >
      <div className="nav-head">
        <span>All Access Objects</span>
        <button className="icon-btn" onClick={props.onToggle} title="Shutter Bar Open/Close (F11)" aria-label="Collapse navigation pane">
          «
        </button>
      </div>
      <label className="nav-search">
        <input placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search objects" />
        <FindIcon size={12} />
      </label>
      <div className="nav-groups" role="tree" tabIndex={-1}>
        {GROUPS.map(({ group, kinds }) => {
          const items = kinds
            .flatMap((kind) => objectsOf(ws.doc, kind).map((o) => ({ kind, id: o.id, name: o.name })))
            .filter((o) => !query || o.name.toLowerCase().includes(query))
            .sort((a, b) => a.name.localeCompare(b.name));
          if (query && !items.length) return null;
          const open = !closedGroups.has(group);
          return (
            <div key={group} className="nav-group" role="treeitem" aria-expanded={open}>
              <button
                className="nav-group-head"
                onClick={() =>
                  setClosedGroups((s) => {
                    const n = new Set(s);
                    if (n.has(group)) n.delete(group);
                    else n.add(group);
                    return n;
                  })
                }
              >
                <span>{KIND_PLURAL[group]}</span>
                <ChevronIcon size={10} className={open ? "chev open" : "chev"} />
              </button>
              {open && (
                <ul role="group">
                  {items.map(({ kind, id, name }) => {
                    const selected = props.selection?.kind === kind && props.selection.id === id;
                    const isRenaming = renaming?.kind === kind && renaming.id === id;
                    return (
                      <li
                        key={`${kind}:${id}`}
                        role="treeitem"
                        aria-selected={selected}
                        tabIndex={0}
                        title={kind === "linked" ? linkTitle(ws.doc.linkedTables?.find((l) => l.id === id)) : undefined}
                        className={`nav-item ${selected ? "selected" : ""} ${ws.activeKey === tabKey(kind, id) ? "active" : ""}`}
                        {...(touch && !isRenaming ? press.bind((x, y) => openMenu(x, y, kind, id)) : {})}
                        onClick={() => {
                          // Touch screens: a tap opens (double-tapping is awkward); long-press shows the menu.
                          if (touch && !isRenaming) {
                            if (!press.wasLongPress()) void openItem(kind, id);
                            return;
                          }
                          props.onSelect({ kind, id });
                        }}
                        onDoubleClick={() => !touch && !isRenaming && openItem(kind, id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          if (Date.now() - menuOpenedAt.current < 600) return; // already opened by the long press
                          openMenu(e.clientX, e.clientY, kind, id);
                        }}
                        onKeyDown={(e) => {
                          if (isRenaming) return;
                          const mod = e.ctrlKey || e.metaKey;
                          if (e.key === "Enter") openItem(kind, id);
                          else if (e.key === "F2") startRename(kind, id);
                          else if (e.key === "Delete") remove(kind, id);
                          else if (mod && e.key.toLowerCase() === "c") props.onCopy(kind, id);
                          else return;
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        onFocus={() => props.onSelect({ kind, id })}
                      >
                        <ItemIcon kind={kind} id={id} />{" "}
                        {isRenaming ? (
                          <RenameBox initial={name} onCommit={(n) => commitRename(kind, id, n)} onCancel={() => setRenaming(null)} />
                        ) : (
                          <span className="nav-item-name">{name}</span>
                        )}
                      </li>
                    );
                  })}
                  {!items.length && <li className="nav-empty">None yet</li>}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      {menu && (
        <div
          className={`context-menu ${compact ? "sheet" : ""}`}
          // Keep it on screen. (On phones it's a sheet at the bottom instead.)
          style={compact ? undefined : { left: Math.max(0, Math.min(menu.x, window.innerWidth - 230)), top: Math.max(0, Math.min(menu.y, window.innerHeight - menuItems.length * 28 - 12)) }}
          onMouseDown={(e) => e.stopPropagation()}
          role="menu"
        >
          {compact && <div className="menu-title">{findObject(ws.doc, menu.kind, menu.id)?.name}</div>}
          {menuItems.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              onClick={() => {
                setMenu(null);
                item.run();
              }}
            >
              <span>{item.label}</span>
              {"shortcut" in item && <span className="menu-shortcut">{item.shortcut}</span>}
            </button>
          ))}
          {compact && (
            <button role="menuitem" className="menu-cancel" onClick={() => setMenu(null)}>
              Cancel
            </button>
          )}
        </div>
      )}
    </aside>
    {publicReport && ws.doc.reports.some((r) => r.id === publicReport) && (
      <PublicReportDialog report={ws.doc.reports.find((r) => r.id === publicReport)!} onClose={() => setPublicReport(null)} />
    )}
    </>
  );
}
