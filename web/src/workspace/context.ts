import { createContext, useContext, useEffect } from "react";
import type { ObjectKind, ProjectDoc } from "../../../shared/model";

export type TabKind = ObjectKind | "relationships";
export type ViewName = "datasheet" | "design" | "sql" | "form" | "report" | "relationships";

export interface Tab {
  key: string;
  kind: TabKind;
  id: string;
  view: ViewName;
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
}

export type StatusKind = "info" | "error";

export interface WorkspaceApi {
  projectId: string;
  projectName: string;
  doc: ProjectDoc;
  /** Applies an immer recipe to the document; each call is one undo step. */
  update: (recipe: (draft: ProjectDoc) => void) => void;
  openObject: (kind: TabKind, id: string, view?: ViewName) => void;
  closeTab: (key: string) => void;
  setTabView: (key: string, view: ViewName) => void;
  activeKey: string | null;
  setStatus: (message: string, kind?: StatusKind) => void;
  registerCommands: (tabKey: string, commands: ViewCommands | null) => void;
  /** View-only access: edits are refused (update() reports it). */
  readOnly: boolean;
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
  return { table: "datasheet", query: "datasheet", form: "form", report: "report", relationships: "relationships" }[kind] as ViewName;
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
    default:
      return [{ view: "relationships", label: "Relationships" }];
  }
}
