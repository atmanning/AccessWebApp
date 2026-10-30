import { useEffect, useState } from "react";
import type { ObjectKind } from "../../../shared/model";
import { useDialogs } from "../ui/dialogs";
import { ChevronIcon, FindIcon, OBJECT_ICONS } from "../ui/icons";
import { tabKey, useWorkspace } from "./context";
import { deleteObject, dependents, findObject, KIND_LABEL, KIND_PLURAL, objectsOf, renameObject, validateObjectName } from "./docOps";

const KINDS: ObjectKind[] = ["table", "query", "form", "report"];

export type Selection = { kind: ObjectKind; id: string } | null;

export function NavPane(props: { selection: Selection; onSelect: (s: Selection) => void; collapsed: boolean; onToggle: () => void }) {
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const [search, setSearch] = useState("");
  const [closedGroups, setClosedGroups] = useState<Set<ObjectKind>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; kind: ObjectKind; id: string } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const rename = async (kind: ObjectKind, id: string) => {
    const obj = findObject(ws.doc, kind, id);
    if (!obj) return;
    const name = await dialogs.prompt("Rename", `${KIND_LABEL[kind]} Name:`, obj.name, (v) =>
      v.trim() === obj.name ? null : validateObjectName(ws.doc, kind, v, id),
    );
    if (name && name !== obj.name) ws.update((d) => renameObject(d, kind, id, name));
  };

  const remove = async (kind: ObjectKind, id: string) => {
    const obj = findObject(ws.doc, kind, id);
    if (!obj) return;
    const deps = dependents(ws.doc, kind, id);
    const ok = await dialogs.confirm(
      "Microsoft Access Web",
      <>
        <p>Do you want to delete the {KIND_LABEL[kind].toLowerCase()} '{obj.name}'?</p>
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

  if (props.collapsed) {
    return (
      <aside className="nav-pane collapsed" aria-label="Navigation Pane">
        <button className="nav-collapse" onClick={props.onToggle} title="Open the Navigation Pane (F11)">
          <span className="nav-collapsed-label">Navigation Pane</span>
        </button>
      </aside>
    );
  }

  const q = search.trim().toLowerCase();
  return (
    <aside className="nav-pane" aria-label="Navigation Pane">
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
      <div className="nav-groups" role="tree">
        {KINDS.map((kind) => {
          const items = objectsOf(ws.doc, kind).filter((o) => !q || o.name.toLowerCase().includes(q));
          if (q && !items.length) return null;
          const open = !closedGroups.has(kind);
          const Icon = OBJECT_ICONS[kind];
          return (
            <div key={kind} className="nav-group" role="treeitem" aria-expanded={open}>
              <button
                className="nav-group-head"
                onClick={() =>
                  setClosedGroups((s) => {
                    const n = new Set(s);
                    if (n.has(kind)) n.delete(kind);
                    else n.add(kind);
                    return n;
                  })
                }
              >
                <span>{KIND_PLURAL[kind]}</span>
                <ChevronIcon size={10} className={open ? "chev open" : "chev"} />
              </button>
              {open && (
                <ul role="group">
                  {[...items].sort((a, b) => a.name.localeCompare(b.name)).map((o) => {
                    const selected = props.selection?.kind === kind && props.selection.id === o.id;
                    return (
                      <li
                        key={o.id}
                        role="treeitem"
                        aria-selected={selected}
                        tabIndex={0}
                        className={`nav-item ${selected ? "selected" : ""} ${ws.activeKey === tabKey(kind, o.id) ? "active" : ""}`}
                        onClick={() => props.onSelect({ kind, id: o.id })}
                        onDoubleClick={() => ws.openObject(kind, o.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          props.onSelect({ kind, id: o.id });
                          setMenu({ x: e.clientX, y: e.clientY, kind, id: o.id });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") ws.openObject(kind, o.id);
                          else if (e.key === "F2") rename(kind, o.id);
                          else if (e.key === "Delete") remove(kind, o.id);
                          else return;
                          e.preventDefault();
                        }}
                        onFocus={() => props.onSelect({ kind, id: o.id })}
                      >
                        <Icon /> <span className="nav-item-name">{o.name}</span>
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
        <div className="context-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()} role="menu">
          {[
            { label: "Open", run: () => ws.openObject(menu.kind, menu.id) },
            { label: "Design View", run: () => ws.openObject(menu.kind, menu.id, "design") },
            ...(menu.kind === "query" ? [{ label: "SQL View", run: () => ws.openObject(menu.kind, menu.id, "sql") }] : []),
            { label: "Rename", run: () => rename(menu.kind, menu.id) },
            { label: "Delete", run: () => remove(menu.kind, menu.id) },
          ].map((item) => (
            <button
              key={item.label}
              role="menuitem"
              onClick={() => {
                setMenu(null);
                item.run();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
