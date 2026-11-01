import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLayout } from "../ui/layout";
import { createPortal } from "react-dom";
import {
  DeleteIcon,
  DeleteRowIcon,
  DesignIcon,
  ExportAccessIcon,
  ImportAccessIcon,
  FindIcon,
  FormIcon,
  ImportIcon,
  InsertRowIcon,
  KeyIcon,
  NewRecordIcon,
  PrintIcon,
  QueryIcon,
  RefreshIcon,
  RelationshipsIcon,
  ReportIcon,
  RunIcon,
  ShowTableIcon,
  SortAscIcon,
  SortDescIcon,
  SqlIcon,
  TableIcon,
  TextFileIcon,
  TotalsIcon,
  ConsoleIcon,
  CopyIcon,
  DatabaseServerIcon,
  LinkedTableIcon,
  OtherDbIcon,
  PasteIcon,
} from "../ui/icons";
import { viewsFor, type Tab, type ViewCommands, type ViewName } from "./context";
import { QUERY_TYPES, QUERY_TYPE_LABELS, type QueryType } from "../../../shared/model";
import { QUERY_TYPE_ICONS } from "./queryKinds";
import { FORM_CONTROL_TYPES, FORM_THEMES } from "../../../shared/model";
import { CONTROL_LABELS, THEMES } from "../forms/formLayout";
import {
  AlignBottomIcon,
  AlignLeftIcon,
  AlignRightIcon,
  AlignTopIcon,
  BackIcon,
  ColumnsIcon,
  CONTROL_ICONS,
  FieldListIcon,
  FrontIcon,
  PropertySheetIcon,
  SameHeightIcon,
  SameWidthIcon,
  StackedIcon,
} from "../forms/formIcons";

const QUERY_TYPE_HELP: Record<QueryType, string> = {
  select: "Select: show records",
  makeTable: "Make Table: save the results as a new table",
  append: "Append: add the results to an existing table",
  update: "Update: change values in existing records",
  crosstab: "Crosstab: summarize with row and column headings",
  delete: "Delete: remove the matching records",
};

export interface RibbonActions {
  openBackstage: () => void;
  setView: (view: ViewName) => void;
  createTable: () => void;
  createTableDesign: () => void;
  createQueryDesign: () => void;
  createForm: () => void;
  createReport: () => void;
  importText: () => void;
  importAccess: () => void;
  copy?: () => void;
  paste?: () => void;
  mysqlConnections: () => void;
  mysqlLink?: () => void;
  mysqlImport?: () => void;
  mysqlConsole?: () => void;
  otherDbImport?: () => void;
  otherDbLink?: () => void;
  exportAccess: () => void;
  openRelationships: () => void;
  refresh: () => void;
}

type RibbonTab = "home" | "create" | "external" | "tools" | "design";

const VIEW_ICONS: Record<ViewName, ReactNode> = {
  console: <ConsoleIcon size={32} />,
  datasheet: <TableIcon size={32} />,
  design: <DesignIcon size={32} />,
  sql: <SqlIcon size={32} />,
  form: <FormIcon size={32} />,
  report: <ReportIcon size={32} />,
  relationships: <RelationshipsIcon size={32} />,
};

const VIEW_ICONS_SMALL: Record<ViewName, ReactNode> = {
  console: <ConsoleIcon size={16} />,
  datasheet: <TableIcon size={16} />,
  design: <DesignIcon size={16} />,
  sql: <SqlIcon size={16} />,
  form: <FormIcon size={16} />,
  report: <ReportIcon size={16} />,
  relationships: <RelationshipsIcon size={16} />,
};

function Big(props: { icon: ReactNode; label: string; onClick?: () => void; title?: string; pressed?: boolean }) {
  return (
    <button
      className={`rb-big ${props.pressed ? "pressed" : ""}`}
      onClick={props.onClick}
      disabled={!props.onClick}
      title={props.title ?? props.label}
      aria-pressed={props.pressed}
    >
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function Small(props: { icon: ReactNode; label: string; onClick?: () => void; title?: string; pressed?: boolean }) {
  return (
    <button className={`rb-small ${props.pressed ? "pressed" : ""}`} onClick={props.onClick} disabled={!props.onClick} title={props.title ?? props.label} aria-pressed={props.pressed}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rb-group">
      <div className="rb-group-body">{children}</div>
      <div className="rb-group-label">{label}</div>
    </div>
  );
}

export function Ribbon({ tab, commands, actions }: { tab: Tab | null; commands: ViewCommands; actions: RibbonActions }) {
  const designContext =
    tab?.kind === "table" && tab.view === "design"
      ? "table"
      : tab?.kind === "query" && (tab.view === "design" || tab.view === "sql")
        ? "query"
        : tab?.kind === "form" && tab.view === "design"
          ? "form"
          : null;
  const [active, setActive] = useState<RibbonTab>("home");
  // Where to draw the View menu. It's rendered at the page level (portal) so the ribbon
  // and navigation pane can't clip or cover it.
  const [viewMenu, setViewMenu] = useState<{ left: number; top: number } | null>(null);
  // Phone layout: only the tab row shows; tapping a tab drops its commands down over the page
  // (like Access's collapsed ribbon), and choosing a command puts them away again.
  const { compact } = useLayout();
  const [open, setOpen] = useState(false);
  const ribbonRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!compact || !open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!ribbonRef.current?.contains(t) && !t.closest(".rb-menu")) setOpen(false);
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [compact, open]);
  useEffect(() => setOpen(false), [compact, tab?.key]);
  const pickTab = (id: RibbonTab) => {
    if (!compact) return setActive(id);
    if (active === id && open) return setOpen(false);
    setActive(id);
    setOpen(true);
  };

  // Like Access, jump to the contextual Design tab when entering Design View.
  useEffect(() => {
    if (designContext) setActive("design");
    else setActive((a) => (a === "design" ? "home" : a));
  }, [designContext, tab?.key]);

  useEffect(() => {
    if (!viewMenu) return;
    const close = () => setViewMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", close);
    };
  }, [viewMenu]);

  const views = tab ? viewsFor(tab.kind) : [];
  // Like Access: the View button opens Design View, and from Design View goes back to the normal view.
  const nextView: ViewName | undefined = !tab
    ? undefined
    : tab.view !== "design" && views.some((v) => v.view === "design")
      ? "design"
      : views.find((v) => v.view !== tab.view)?.view;
  const c = commands;

  const viewButton = (
    <div className="rb-split">
      <Big icon={VIEW_ICONS[nextView ?? "datasheet"]} label="View" onClick={nextView ? () => actions.setView(nextView) : undefined} title={nextView ? views.find((v) => v.view === nextView)?.label : "View"} />
      <button
        className="rb-split-arrow"
        disabled={!tab}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          const r = (e.currentTarget.parentElement ?? e.currentTarget).getBoundingClientRect();
          setViewMenu((m) => (m ? null : { left: r.left, top: r.bottom + 2 }));
        }}
        aria-label="Choose view"
        aria-expanded={!!viewMenu}
      >
        ▾
      </button>
      {viewMenu &&
        tab &&
        createPortal(
          <div className="rb-menu" role="menu" style={{ left: viewMenu.left, top: viewMenu.top }} onMouseDown={(e) => e.stopPropagation()}>
            {views.map((v) => (
              <button
                key={v.view}
                role="menuitem"
                className={v.view === tab.view ? "current" : ""}
                onClick={() => {
                  setViewMenu(null);
                  setOpen(false);
                  actions.setView(v.view);
                }}
              >
                {VIEW_ICONS_SMALL[v.view]} {v.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );

  return (
    <div className={`ribbon ${compact ? "compact" : ""} ${compact && open ? "open" : ""}`} ref={ribbonRef}>
      <div className="ribbon-tabs" role="tablist">
        <button className="ribbon-file" onClick={actions.openBackstage}>File</button>
        {(
          [
            ["home", "Home"],
            ["create", "Create"],
            ["external", "External Data"],
            ["tools", "Database Tools"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={active === id} className={active === id && (!compact || open) ? "active" : ""} onClick={() => pickTab(id)}>
            {label}
          </button>
        ))}
        {designContext && (
          <button role="tab" aria-selected={active === "design"} className={`contextual ${active === "design" && (!compact || open) ? "active" : ""}`} onClick={() => pickTab("design")}>
            {designContext === "table" ? "Table Design" : designContext === "query" ? "Query Design" : "Form Design"}
          </button>
        )}
      </div>
      {(!compact || open) && (
      <div
        className={`ribbon-body ${compact ? "dropdown" : ""}`}
        onClick={(e) => {
          // Phone layout: a command was chosen, so put the ribbon away.
          const b = (e.target as HTMLElement).closest("button");
          if (compact && b && !b.disabled && !b.classList.contains("rb-split-arrow")) setOpen(false);
        }}
      >
        {active === "home" && (
          <>
            <Group label="Views">{viewButton}</Group>
            <Group label="Clipboard">
              <Big icon={<PasteIcon size={32} />} label="Paste" onClick={actions.paste} title="Paste a copied table, query, form or report (Ctrl+V)" />
              <div className="rb-stack">
                <Small icon={<CopyIcon />} label="Copy" onClick={actions.copy} title="Copy the object selected in the Navigation Pane (Ctrl+C)" />
              </div>
            </Group>
            {(tab?.kind === "query" || tab?.kind === "console") && c.run && (
              <Group label="Results">
                <Big icon={<RunIcon size={32} />} label="Run" onClick={c.run} title="Run this query" />
              </Group>
            )}
            <Group label="Sort & Filter">
              <div className="rb-stack">
                <Small icon={<SortAscIcon />} label="Ascending" onClick={c.sortAsc} />
                <Small icon={<SortDescIcon />} label="Descending" onClick={c.sortDesc} />
                <Small icon={<span className="rb-x">✕</span>} label="Remove Sort" onClick={c.removeSort} />
              </div>
            </Group>
            <Group label="Records">
              <Big icon={<RefreshIcon size={32} />} label="Refresh All" onClick={actions.refresh} />
              <div className="rb-stack">
                <Small icon={<NewRecordIcon />} label="New" onClick={c.newRecord} />
                <Small icon={<DeleteIcon />} label="Delete" onClick={c.deleteRecord} />
              </div>
            </Group>
            <Group label="Find">
              <Big icon={<FindIcon size={32} />} label="Find" onClick={c.find} />
            </Group>
            {c.print && (
              <Group label="Print">
                <Big icon={<PrintIcon size={32} />} label="Print" onClick={c.print} />
              </Group>
            )}
          </>
        )}
        {active === "create" && (
          <>
            <Group label="Tables">
              <Big icon={<TableIcon size={32} />} label="Table" onClick={actions.createTable} />
              <Big icon={<DesignIcon size={32} />} label="Table Design" onClick={actions.createTableDesign} />
            </Group>
            <Group label="Queries">
              <Big icon={<QueryIcon size={32} />} label="Query Design" onClick={actions.createQueryDesign} />
            </Group>
            <Group label="Forms">
              <Big icon={<FormIcon size={32} />} label="Form" onClick={actions.createForm} title="Create a form from the selected table or query" />
            </Group>
            <Group label="Reports">
              <Big icon={<ReportIcon size={32} />} label="Report" onClick={actions.createReport} title="Create a report from the selected table or query" />
            </Group>
          </>
        )}
        {active === "external" && (
          <>
            <Group label="Import & Link">
              <Big icon={<ImportAccessIcon size={32} />} label="Access" onClick={actions.importAccess} title="Import tables and queries from an Access database (.accdb, .mdb)" />
              <Big icon={<ImportIcon size={32} />} label="Text File" onClick={actions.importText} title="Import a CSV or text file into a new table" />
            </Group>
            <Group label="Other Databases">
              <Big icon={<OtherDbIcon size={32} />} label="Import Objects" onClick={actions.otherDbImport} title="Copy tables and queries from another of your databases, or one shared with you" />
              <Big icon={<LinkedTableIcon size={32} />} label="Link Objects" onClick={actions.otherDbLink} title="Link to tables and select queries in another of your databases, or one shared with you" />
            </Group>
            <Group label="MySQL">
              <Big icon={<DatabaseServerIcon size={32} />} label="Connections" onClick={actions.mysqlConnections} title="Add, edit and test MySQL / MariaDB connections" />
              <Big icon={<LinkedTableIcon size={32} />} label="Link Tables" onClick={actions.mysqlLink} title="Link tables from a MySQL database to browse them here" />
              <Big icon={<ImportIcon size={32} />} label="Import Tables" onClick={actions.mysqlImport} title="Copy tables and their data from a MySQL database" />
              <Big icon={<ConsoleIcon size={32} />} label="SQL Console" onClick={actions.mysqlConsole} title="Run SQL on a MySQL connection" />
            </Group>
            <Group label="Export">
              <Big icon={<ExportAccessIcon size={32} />} label="Access" onClick={actions.exportAccess} title="Download this database as a Microsoft Access .accdb file" />
              <Big icon={<TextFileIcon size={32} />} label="Text File" onClick={c.exportText} title="Export the open table or query as CSV" />
            </Group>
          </>
        )}
        {active === "tools" && (
          <>
            <Group label="Relationships">
              <Big icon={<RelationshipsIcon size={32} />} label="Relationships" onClick={actions.openRelationships} />
              {c.addRelationship && <Big icon={<PlusBox />} label="Add Relationship" onClick={c.addRelationship} />}
            </Group>
          </>
        )}
        {active === "design" && designContext === "table" && (
          <>
            <Group label="Views">{viewButton}</Group>
            <Group label="Tools">
              <Big icon={<KeyIcon size={32} />} label="Primary Key" onClick={c.primaryKey} />
              <div className="rb-stack">
                <Small icon={<InsertRowIcon />} label="Insert Rows" onClick={c.insertRows} />
                <Small icon={<DeleteRowIcon />} label="Delete Rows" onClick={c.deleteRows} />
              </div>
            </Group>
          </>
        )}
        {active === "design" && designContext === "form" && c.formDesign && (() => {
          const f = c.formDesign;
          const many = f.selectionCount > 1;
          const chunks = [FORM_CONTROL_TYPES.slice(0, 3), FORM_CONTROL_TYPES.slice(3, 6), FORM_CONTROL_TYPES.slice(6)];
          return (
            <>
              <Group label="Views">{viewButton}</Group>
              <Group label="Themes">
                <div className="rb-themes">
                  {FORM_THEMES.map((t) => (
                    <button
                      key={t}
                      className={`rb-theme ${f.theme === t ? "pressed" : ""}`}
                      aria-pressed={f.theme === t}
                      title={`${THEMES[t].label} theme`}
                      onClick={() => f.setTheme(t)}
                      style={{ background: THEMES[t].canvas }}
                    >
                      <span className="rb-theme-head" style={{ background: THEMES[t].header === "#ffffff" ? THEMES[t].accent : THEMES[t].header }} />
                      <span className="rb-theme-name" style={{ color: THEMES[t].canvas === "#0b1020" ? "#e5e7eb" : "#333" }}>{THEMES[t].label}</span>
                    </button>
                  ))}
                </div>
              </Group>
              <Group label="Controls">
                {chunks.map((chunk, i) => (
                  <div className="rb-stack" key={i}>
                    {chunk.map((t) => {
                      const Icon = CONTROL_ICONS[t];
                      return <Small key={t} icon={<Icon />} label={CONTROL_LABELS[t]} pressed={f.tool === t} onClick={() => f.setTool(t)} title={`${CONTROL_LABELS[t]}: click, then click or drag on the form`} />;
                    })}
                  </div>
                ))}
              </Group>
              <Group label="Tools">
                <Big icon={<FieldListIcon size={32} />} label="Add Existing Fields" pressed={f.fieldList} onClick={f.toggleFieldList} title="Show or hide the toolbox and field list" />
                <Big icon={<PropertySheetIcon size={32} />} label="Property Sheet" pressed={f.propertySheet} onClick={f.togglePropertySheet} />
              </Group>
              <Group label="Layout">
                <Big icon={<StackedIcon size={32} />} label="Stacked" onClick={() => f.relayout("stacked")} title="Arrange the fields in one column" />
                <Big icon={<ColumnsIcon size={32} />} label="Two Columns" onClick={() => f.relayout("columns")} title="Arrange the fields in two columns" />
              </Group>
              <Group label="Arrange">
                <div className="rb-stack">
                  <Small icon={<AlignLeftIcon />} label="Align Left" onClick={many ? () => f.align("left") : undefined} />
                  <Small icon={<AlignRightIcon />} label="Align Right" onClick={many ? () => f.align("right") : undefined} />
                  <Small icon={<SameWidthIcon />} label="Same Width" onClick={many ? () => f.sameSize("width") : undefined} title="Make the selected controls as wide as the widest" />
                </div>
                <div className="rb-stack">
                  <Small icon={<AlignTopIcon />} label="Align Top" onClick={many ? () => f.align("top") : undefined} />
                  <Small icon={<AlignBottomIcon />} label="Align Bottom" onClick={many ? () => f.align("bottom") : undefined} />
                  <Small icon={<SameHeightIcon />} label="Same Height" onClick={many ? () => f.sameSize("height") : undefined} title="Make the selected controls as tall as the tallest" />
                </div>
                <div className="rb-stack">
                  <Small icon={<FrontIcon />} label="Bring to Front" onClick={f.selectionCount ? () => f.order("front") : undefined} />
                  <Small icon={<BackIcon />} label="Send to Back" onClick={f.selectionCount ? () => f.order("back") : undefined} />
                  <Small icon={<DeleteIcon />} label="Delete" onClick={f.selectionCount ? f.remove : undefined} />
                </div>
              </Group>
            </>
          );
        })()}
        {active === "design" && designContext === "query" && (
          <>
            <Group label="Results">
              {viewButton}
              <Big icon={<RunIcon size={32} />} label="Run" onClick={c.run} />
            </Group>
            <Group label="Query Type">
              {QUERY_TYPES.map((t) => {
                const Icon = QUERY_TYPE_ICONS[t];
                return (
                  <Big
                    key={t}
                    icon={<Icon size={32} />}
                    label={QUERY_TYPE_LABELS[t]}
                    pressed={c.queryType === t}
                    onClick={c.setQueryType ? () => c.setQueryType!(t) : undefined}
                    title={QUERY_TYPE_HELP[t]}
                  />
                );
              })}
            </Group>
            <Group label="Query Setup">
              <Big icon={<ShowTableIcon size={32} />} label="Show Table" onClick={c.showTable} />
            </Group>
            <Group label="Show/Hide">
              <Big icon={<TotalsIcon size={32} />} label="Totals" pressed={!!c.totals} onClick={c.toggleTotals} title="Show the Total row (Group By, Sum, Count, ...)" />
            </Group>
          </>
        )}
      </div>
      )}
    </div>
  );
}

function PlusBox() {
  return (
    <svg width={32} height={32} viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1" y="2" width="5" height="7" fill="#fff" stroke="#3b6ea5" />
      <path d="M12 4v8M8 8h8" stroke="#2e7d4f" strokeWidth="1.6" />
    </svg>
  );
}
