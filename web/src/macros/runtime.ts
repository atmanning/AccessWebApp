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

/** Forms shown in subform controls, by the subform control's name ([Tasks subform]![Total]). */
const subforms = new Map<string, FormHandle>();
export function registerSubform(controlName: string, h: FormHandle): () => void {
  const key = controlName.toLowerCase();
  subforms.set(key, h);
  return () => {
    if (subforms.get(key) === h) subforms.delete(key);
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

/** The form whose macro is running, and the control whose event started it ([Screen].[ActiveControl]). */
export const macroContext: { form?: FormHandle; activeControl?: string } = {};

setQualifiedResolver((path) => {
  const root = path[0].toLowerCase();
  const p1 = path[1]?.toLowerCase();
  const f = macroContext.form;
  if (root === "screen" && path.length === 2) {
    if (p1 === "activecontrol" && f && macroContext.activeControl) return { value: f.value(macroContext.activeControl) ?? null };
    if ((p1 === "activeform" || p1 === "activedatasheet") && f) return { value: f.name };
  }
  // Templates check these before using features Access blocks in untrusted databases.
  if (root === "currentproject" && path.length === 2 && p1 === "istrusted") return { value: true };
  if (root === "application" && path.length === 2) {
    if (p1 === "currentobjectname" && f) return { value: f.name };
    if (p1 === "currentobjecttype") return { value: 2 }; // acForm
  }
  // [Form]![Control] or [Form].[FilterOn]: the form running the macro.
  // [Tasks subform].[Form]![Total] or [Tasks subform]![Total]: a control of the form in a subform control.
  const sub = path.length >= 2 ? subforms.get(root) : undefined;
  if (sub) {
    const rest = path.slice(1).filter((x, i) => !(i === 0 && /^form$/i.test(x)));
    const v = rest.length === 1 ? sub.value(rest[0]) : undefined;
    if (v !== undefined) return { value: v };
  }
  if ((root === "form" || root === "me") && path.length === 2 && f) {
    const v = f.value(path[1]);
    if (v !== undefined) return { value: v };
  }
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
