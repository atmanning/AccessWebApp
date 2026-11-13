import { createContext, useContext, useEffect } from "react";
import type { ConnectionInfo, FormControlType, FormTheme, ObjectKind, ProjectDoc, QueryType } from "../../../shared/model";

/** "console" tabs are the MySQL SQL console; their id is the connection id. */
export type TabKind = ObjectKind | "relationships" | "console";
export type ViewName = "datasheet" | "design" | "sql" | "form" | "report" | "relationships" | "console";

export interface Tab {
  key: string;
  kind: TabKind;
  id: string;
  view: ViewName;
  /** Go to the record whose `field` equals `value` (from a link such as a label's QR code); `n` makes repeats count. */
  goto?: RecordTarget;
}

export interface RecordTarget {
  field: string;
  value: string;
  n: number;
}

/** A link into a database: open this form or table at the record whose key field has this value. */
export interface DeepLink {
  kind: "form" | "table";
  id: string;
  field: string;
  value: string;
}

/** Commands the ribbon can send to whichever view is active. */
export interface ViewCommands {
  newRecord?: () => void;
  deleteRecord?: () => void;
  sortAsc?: () => void;
  sortDesc?: () => void;
  removeSort?: () => void;
  find?: () => void;
  primaryKey?: () => void;
  insertRows?: () => void;
  deleteRows?: () => void;
  run?: () => void;
  showTable?: () => void;
  print?: () => void;
  exportText?: () => void;
  addRelationship?: () => void;
  /** Form View: Find mode (Filter by Form) and the filter it applies. */
  filterByForm?: () => void;
  toggleFilter?: () => void;
  filterOn?: boolean;
  /** Datasheet: set the height of every row (Home > Records > Row Height). */
  rowHeight?: () => void;
  /** Query Design: switch query type, and the current type / Totals state for the ribbon. */
  setQueryType?: (type: QueryType) => void;
  queryType?: QueryType;
  toggleTotals?: () => void;
  totals?: boolean;
  /** Form Design View: toolbox, panes, themes and arranging controls. */
  formDesign?: FormDesignCommands;
}

export interface FormDesignCommands {
  tool: FormControlType | null;
  setTool: (t: FormControlType | null) => void;
  selectionCount: number;
  align: (edge: "left" | "right" | "top" | "bottom") => void;
  sameSize: (dim: "width" | "height") => void;
  order: (where: "front" | "back") => void;
  theme: FormTheme;
  setTheme: (t: FormTheme) => void;
  fieldList: boolean;
  toggleFieldList: () => void;
  propertySheet: boolean;
  togglePropertySheet: () => void;
  relayout: (style: "stacked" | "columns") => void;
  remove: () => void;
  /** Opens the Tab Order dialog. */
  tabOrder: () => void;
}

export type StatusKind = "info" | "error";

export interface WorkspaceApi {
  projectId: string;
  projectName: string;
  doc: ProjectDoc;
  /** Applies an immer recipe to the document; each call is one undo step. */
  update: (recipe: (draft: ProjectDoc) => void) => void;
  openObject: (kind: TabKind, id: string, view?: ViewName, goto?: Omit<RecordTarget, "n">) => void;
  closeTab: (key: string) => void;
  setTabView: (key: string, view: ViewName) => void;
  activeKey: string | null;
  setStatus: (message: string, kind?: StatusKind) => void;
  registerCommands: (tabKey: string, commands: ViewCommands | null) => void;
  /** View-only access: edits are refused (update() reports it). */
  readOnly: boolean;
  /** Saved MySQL connections for this database (null while loading). */
  connections: ConnectionInfo[] | null;
  refreshConnections: () => Promise<void>;
  /** Address of a picture stored in an Image field. */
  imageUrl: (imageId: string, projectId?: string) => string;
  /** Stores a picture (shrinking big photos first) and returns its id for the cell. */
  uploadImage: (file: Blob) => Promise<string>;
  /** After pasting or importing from another database, copies the pictures `objects` mention. */
  copyPicturesFrom: (sourceProjectId: string, objects: unknown) => void;
}

export const WorkspaceContext = createContext<WorkspaceApi | null>(null);
export const useWorkspace = () => useContext(WorkspaceContext)!;

/** Lets a view expose ribbon commands while it is mounted. */
export function useCommands(tabKey: string, commands: ViewCommands) {
  const ws = useWorkspace();
  // Re-register every render so handlers see current state; registration itself is cheap.
  useEffect(() => {
    ws.registerCommands(tabKey, commands);
  });
  useEffect(() => () => ws.registerCommands(tabKey, null), [tabKey]); // eslint-disable-line react-hooks/exhaustive-deps
}

export const tabKey = (kind: TabKind, id: string) => `${kind}:${id}`;

export function defaultView(kind: TabKind): ViewName {
  return { table: "datasheet", query: "datasheet", form: "form", report: "report", relationships: "relationships", linked: "datasheet", console: "console" }[kind] as ViewName;
}

export function viewsFor(kind: TabKind): { view: ViewName; label: string }[] {
  switch (kind) {
    case "table":
      return [{ view: "datasheet", label: "Datasheet View" }, { view: "design", label: "Design View" }];
    case "query":
      return [
        { view: "datasheet", label: "Datasheet View" },
        { view: "sql", label: "SQL View" },
        { view: "design", label: "Design View" },
      ];
    case "form":
      return [{ view: "form", label: "Form View" }, { view: "design", label: "Design View" }];
    case "report":
      return [{ view: "report", label: "Report View" }, { view: "design", label: "Design View" }];
    case "linked":
      return [{ view: "datasheet", label: "Datasheet View" }];
    case "console":
      return [{ view: "console", label: "SQL Console" }];
    default:
      return [{ view: "relationships", label: "Relationships" }];
  }
}
