import { useEffect, useState, type ReactNode } from "react";
import {
  DeleteIcon,
  DeleteRowIcon,
  DesignIcon,
  ExportAccessIcon,
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
} from "../ui/icons";
import { viewsFor, type Tab, type ViewCommands, type ViewName } from "./context";

export interface RibbonActions {
  openBackstage: () => void;
  setView: (view: ViewName) => void;
  createTable: () => void;
  createTableDesign: () => void;
  createQueryDesign: () => void;
  createForm: () => void;
  createReport: () => void;
  importText: () => void;
  exportAccess: () => void;
  openRelationships: () => void;
  refresh: () => void;
}

type RibbonTab = "home" | "create" | "external" | "tools" | "design";

const VIEW_ICONS: Record<ViewName, ReactNode> = {
  datasheet: <TableIcon size={32} />,
  design: <DesignIcon size={32} />,
  sql: <SqlIcon size={32} />,
  form: <FormIcon size={32} />,
  report: <ReportIcon size={32} />,
  relationships: <RelationshipsIcon size={32} />,
};

function Big(props: { icon: ReactNode; label: string; onClick?: () => void; title?: string }) {
  return (
    <button className="rb-big" onClick={props.onClick} disabled={!props.onClick} title={props.title ?? props.label}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function Small(props: { icon: ReactNode; label: string; onClick?: () => void; title?: string }) {
  return (
    <button className="rb-small" onClick={props.onClick} disabled={!props.onClick} title={props.title ?? props.label}>
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
        : null;
  const [active, setActive] = useState<RibbonTab>("home");
  const [viewMenu, setViewMenu] = useState(false);

  // Like Access, jump to the contextual Design tab when entering Design View.
  useEffect(() => {
    if (designContext) setActive("design");
    else setActive((a) => (a === "design" ? "home" : a));
  }, [designContext, tab?.key]);

  useEffect(() => {
    if (!viewMenu) return;
    const close = () => setViewMenu(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [viewMenu]);

  const views = tab ? viewsFor(tab.kind) : [];
  const nextView = tab ? views.find((v) => v.view !== tab.view)?.view : undefined;
  const c = commands;

  const viewButton = (
    <div className="rb-split">
      <Big icon={VIEW_ICONS[nextView ?? "datasheet"]} label="View" onClick={nextView ? () => actions.setView(nextView) : undefined} title={nextView ? views.find((v) => v.view === nextView)?.label : "View"} />
      <button className="rb-split-arrow" disabled={!tab} onMouseDown={(e) => e.stopPropagation()} onClick={() => setViewMenu((v) => !v)} aria-label="Choose view">▾</button>
      {viewMenu && tab && (
        <div className="rb-menu" onMouseDown={(e) => e.stopPropagation()}>
          {views.map((v) => (
            <button key={v.view} className={v.view === tab.view ? "current" : ""} onClick={() => { setViewMenu(false); actions.setView(v.view); }}>
              {v.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="ribbon">
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
          <button key={id} role="tab" aria-selected={active === id} className={active === id ? "active" : ""} onClick={() => setActive(id)}>
            {label}
          </button>
        ))}
        {designContext && (
          <button role="tab" aria-selected={active === "design"} className={`contextual ${active === "design" ? "active" : ""}`} onClick={() => setActive("design")}>
            {designContext === "table" ? "Table Design" : "Query Design"}
          </button>
        )}
      </div>
      <div className="ribbon-body">
        {active === "home" && (
          <>
            <Group label="Views">{viewButton}</Group>
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
              <Big icon={<ImportIcon size={32} />} label="Text File" onClick={actions.importText} title="Import a CSV or text file into a new table" />
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
        {active === "design" && designContext === "query" && (
          <>
            <Group label="Results">
              {viewButton}
              <Big icon={<RunIcon size={32} />} label="Run" onClick={c.run} />
            </Group>
            <Group label="Query Setup">
              <Big icon={<ShowTableIcon size={32} />} label="Show Table" onClick={c.showTable} />
            </Group>
          </>
        )}
      </div>
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
