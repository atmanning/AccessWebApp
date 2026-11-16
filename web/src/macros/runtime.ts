/**
 * What macros share while a database is open: temporary variables ([TempVars]![Name]) and the
 * open forms, so expressions anywhere can read [Forms]![Orders]![CustomerID] and macros can
 * act on a form by name (GoToRecord, Requery, SetProperty…).
 */
import { ExprError, setQualifiedResolver, type ExprValue } from "../engine/expr";

/** What an open form lets macros do to it. */
export interface FormHandle {
  formId: string;
  name: string;
  tabKey: string;
  /** A control's (or field's) value on the current record, or undefined when there's no such name. */
  value(name: string): ExprValue | undefined;
  /** Evaluates an expression against the current record (fields, controls, the form's records). */
  evaluate(expression: string): ExprValue;
  goToRecord(record: string, offset: number): void;
  goToControl(name: string): boolean;
  newRecord(): void;
  saveRecord(): void;
  deleteRecord(): Promise<void>;
  undo(): void;
  requery(): void;
  /** Shows only the records matching the expression; null shows all of them. */
  applyFilter(where: string | null): void;
  findRecord(text: string, match: string): boolean;
  setValue(name: string, value: ExprValue): string | null;
  setProperty(name: string, property: string, value: ExprValue): string | null;
  close(): void;
}

export const tempVars = new Map<string, ExprValue>();
const openForms = new Map<string, FormHandle>();

export function registerForm(h: FormHandle): () => void {
  const key = h.name.toLowerCase();
  openForms.set(key, h);
  return () => {
    if (openForms.get(key) === h) openForms.delete(key);
  };
}

export function openForm(name: string): FormHandle | undefined {
  return openForms.get(name.replace(/^\[|\]$/g, "").toLowerCase());
}

/**
 * An open form's state while its tab is open, also while another tab is in front (the view is
 * unmounted then): what's typed in unbound controls, its filter, its record… so switching tabs
 * doesn't reset it, and On Load / On Close run once, when it opens and when its tab closes.
 */
export interface FormSession {
  state: Record<string, unknown>;
  loaded?: boolean;
  appliedOpen?: number;
  lastCurrent?: string;
  onClose?: () => void;
  unregister?: () => void;
}
export const formSessions = new Map<string, FormSession>();

export function formSession(tabKey: string): FormSession {
  let s = formSessions.get(tabKey);
  if (!s) formSessions.set(tabKey, (s = { state: {} }));
  return s;
}

/** The form's tab closed: forget it, and run its On Close. */
export function endFormSession(tabKey: string) {
  const s = formSessions.get(tabKey);
  if (!s) return;
  formSessions.delete(tabKey);
  s.unregister?.();
  s.onClose?.();
}

export function endAllFormSessions() {
  for (const key of [...formSessions.keys()]) endFormSession(key);
}

/** Clears what one database's macros left behind (opening another database). */
export function resetRuntime() {
  tempVars.clear();
  openForms.clear();
  formSessions.clear();
}

/** Local variables of the running macro ([LocalVars]![Name]); one macro runs at a time. */
export const localVars = new Map<string, ExprValue>();
export const macroError: { number: number; description: string; actionName: string } = { number: 0, description: "", actionName: "" };

setQualifiedResolver((path) => {
  const root = path[0].toLowerCase();
  if (root === "tempvars" && path.length === 2) return { value: tempVars.get(path[1].toLowerCase()) ?? null };
  if (root === "localvars" && path.length === 2) return { value: localVars.get(path[1].toLowerCase()) ?? null };
  if (root === "macroerror" && path.length === 2) {
    const p = path[1].toLowerCase();
    return { value: p === "number" ? macroError.number : p === "description" ? macroError.description : p === "actionname" ? macroError.actionName : null };
  }
  if (root === "forms" && path.length >= 2) {
    const f = openForm(path[1]);
    if (!f) throw new FormNotOpen(path[1]);
    if (path.length === 2) return { value: f.name };
    // [Forms]![Orders]![Total].[Value] → the control's value.
    const name = path.length > 3 && /^value$/i.test(path[3]) ? path[2] : path[path.length - 1];
    const v = f.value(name);
    if (v === undefined) throw new FormNotOpen(path[1], name);
    return { value: v };
  }
  return undefined;
});

export class FormNotOpen extends ExprError {
  constructor(form: string, control?: string) {
    super(control ? `The form '${form}' has no control named '${control}'.` : `The form '${form}' isn't open.`, "#Name?");
  }
}
