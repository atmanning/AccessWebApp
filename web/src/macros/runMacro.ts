/**
 * Runs a macro's steps the way Access does: one action after another, If blocks by their
 * conditions, arguments that start with = worked out first, and OnError deciding what a failed
 * action does (by default: say why, and stop).
 */
import { canonicalAction, MACRO_ACTIONS, type MacroStep } from "../../../shared/macros";
import type { ProjectDoc } from "../../../shared/model";
import { truthy, type ExprValue } from "../engine/expr";
import { macroContext, macroError, openForm, tempVars, type FormHandle } from "./runtime";

/** Asks the workspace to show New Labels (detail: a table or query name, or ""). */
export const NEW_LABELS_EVENT = "accessweb:new-labels";

export type OpenKind = "form" | "report" | "table" | "query";

export interface MacroEnv {
  /** Report a failed action in the status bar instead of a message box (events that run on their own, like On Load). */
  quietErrors?: boolean;
  /** The control whose event runs the macro ([Screen].[ActiveControl]). */
  activeControl?: string;
  /** The form whose event runs the macro (what actions without an Object Name act on). */
  form?: FormHandle;
  /** Works out an expression (with the form's record, when there is one). Throws when it can't. */
  evaluate(expression: string): ExprValue;
  /** The database as it is now (a RunSQL earlier in the macro may have changed it). */
  doc(): ProjectDoc;
  open(kind: OpenKind, id: string, view: "design" | "sql" | undefined, opts: { where?: string; dataMode?: string; print?: boolean; openArgs?: string }): void;
  close(kind: OpenKind, id: string): void;
  closeAll(): void;
  /** Runs an action query's SQL; asks first unless warnings are off. Throws on errors. */
  runSql(sql: string, warnings: boolean): Promise<void>;
  /** Runs a saved action query (OpenQuery on one); false when it's a select query. */
  runActionQuery(id: string, warnings: boolean): Promise<boolean>;
  message(text: string, title: string, type: string): Promise<void>;
  /** MsgBox() in an expression: asks, and returns the button clicked (1 OK, 2 Cancel, 6 Yes, 7 No). */
  ask(text: string, title: string, buttons: number): Promise<number>;
  status(text: string, kind?: "info" | "error"): void;
  beep(): void;
  print(): void;
  /** Opens a web address (http, https, mailto, tel) in a new tab or the mail app. */
  openUrl?(url: string): void;
  /** OpenForm as a dialog: waits until that form is closed again. */
  waitClosed?(kind: OpenKind, id: string): Promise<void>;
  /** Hands the person a file to save (a contact card). */
  download?(name: string, mime: string, text: string): void;
}

export interface MacroResult {
  ok: boolean;
  /** CancelEvent ran. */
  cancelled: boolean;
  error?: string;
}

class Stop {
  constructor(readonly all: boolean) {}
}
export class MacroActionError extends Error {}

interface RunState {
  env: MacroEnv;
  warnings: boolean;
  onError: { mode: "fail" | "next" | "macro"; macro?: string };
  cancelled: boolean;
  /** Submacros of the macro being run (RunMacro "Name" and OnError Macro Name find them first). */
  submacros: Map<string, MacroStep[]>;
  depth: number;
  /** This macro's local variables (SetLocalVar). */
  locals: Map<string, ExprValue>;
  /** Makes this macro the one [Form], [Screen] and [LocalVars] refer to. */
  enter: () => void;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const bare = (name: string) => name.trim().replace(/^\[|\]$/g, "");

/** Runs the steps. `steps` may be a named macro's (its submacros are callable by name). */
export async function runMacro(steps: readonly MacroStep[], env: MacroEnv): Promise<MacroResult> {
  // Macros can run side by side (a button's On Got Focus while its On Click waits for a dialog), so
  // each one has its own form, active control and local variables, put in place whenever it works
  // something out (expressions are worked out in one go, between the awaits).
  const locals = new Map<string, ExprValue>();
  const enter = () => {
    macroContext.form = env.form;
    macroContext.activeControl = env.activeControl;
    macroContext.locals = locals;
  };
  const own: MacroEnv = {
    ...env,
    evaluate: (x) => {
      enter();
      return env.evaluate(x);
    },
  };
  const state: RunState = { env: own, locals, enter, warnings: true, onError: { mode: "fail" }, cancelled: false, submacros: submacrosOf(steps), depth: 0 };
  const outer = { ...macroContext };
  enter();
  try {
    await runSteps(steps, state);
    return { ok: true, cancelled: state.cancelled };
  } catch (e) {
    if (e instanceof Stop) return { ok: true, cancelled: state.cancelled };
    return { ok: false, cancelled: state.cancelled, error: (e as Error).message };
  } finally {
    macroContext.form = outer.form;
    macroContext.activeControl = outer.activeControl;
    macroContext.locals = outer.locals;
  }
}

function submacrosOf(steps: readonly MacroStep[]) {
  const m = new Map<string, MacroStep[]>();
  for (const s of steps) if (s.kind === "submacro") m.set(s.name.toLowerCase(), s.steps);
  return m;
}

async function runSteps(steps: readonly MacroStep[], st: RunState): Promise<void> {
  for (const s of steps) {
    switch (s.kind) {
      case "comment":
        continue;
      case "submacro":
        // A macro's own actions end where its first submacro starts.
        return;
      case "group":
        await runSteps(s.steps, st);
        continue;
      case "if": {
        for (const b of s.branches) {
          if (b.condition === undefined || b.condition.trim() === "" || truthy(await condition(b.condition, st))) {
            await runSteps(b.steps, st);
            break;
          }
        }
        continue;
      }
      case "action":
        try {
          st.enter();
          await runAction(canonicalAction(s.action), s.args ?? {}, st);
        } catch (e) {
          if (e instanceof Stop) throw e;
          const message = (e as Error).message;
          macroError.number = 2001;
          macroError.description = message;
          macroError.actionName = s.action;
          if (st.onError.mode === "next") continue;
          if (st.onError.mode === "macro" && st.onError.macro) {
            await runNamed(st.onError.macro, st);
            throw new Stop(false);
          }
          if (!st.env.quietErrors) await st.env.message(`${s.action} failed: ${message}`, "Action Failed", "Critical");
          throw new MacroActionError(`${s.action}: ${message}`);
        }
        await tick();
    }
  }
}

/** Where MsgBox( starts in an expression (outside quoted text), or -1. */
function findMsgBox(text: string, from = 0): number {
  let inStr = false;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '"') inStr = !inStr;
    else if (!inStr && /^msgbox\s*\(/i.test(text.slice(i, i + 12)) && !/[\w\]]/.test(text[i - 1] ?? "")) return i;
  }
  return -1;
}

/** Splits "a, b, c" on top-level commas. */
function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (const ch of text) {
    if (ch === '"') inStr = !inStr;
    if (!inStr && (ch === "(" || ch === "[")) depth++;
    if (!inStr && (ch === ")" || ch === "]")) depth--;
    if (!inStr && depth === 0 && ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Works out an expression. MsgBox("Delete it?", 4) = 6 asks first (as in Access's macro
 * conditions), then the answer takes its place.
 */
async function evaluateAsync(text: string, st: RunState): Promise<ExprValue> {
  let src = text;
  for (let guard = 0, at = findMsgBox(src); at >= 0 && guard < 10; guard++, at = findMsgBox(src)) {
    const open = src.indexOf("(", at);
    let depth = 0;
    let inStr = false;
    let close = -1;
    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === "(") depth++;
      if (ch === ")" && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0) break;
    const [prompt, buttons, title] = splitTop(src.slice(open + 1, close));
    const v = (e: string | undefined) => (e && e.trim() ? st.env.evaluate(e) : null);
    const answer = await st.env.ask(String(v(prompt) ?? ""), String(v(title) ?? ""), Number(v(buttons) ?? 0) || 0);
    src = `${src.slice(0, at)}${answer}${src.slice(close + 1)}`;
  }
  return st.env.evaluate(src);
}

async function condition(text: string, st: RunState): Promise<ExprValue> {
  try {
    return await evaluateAsync(text, st);
  } catch (e) {
    throw new MacroActionError(`The condition ${text} can't be worked out: ${(e as Error).message}`);
  }
}

/** A literal argument, or the value of one that starts with =. */
async function argText(raw: string | undefined, st: RunState): Promise<string> {
  if (raw === undefined) return "";
  if (!raw.trimStart().startsWith("=")) return raw;
  const v = await evaluateAsync(raw, st);
  return v === null ? "" : typeof v === "boolean" ? (v ? "True" : "False") : String(v);
}

async function argValue(raw: string | undefined, st: RunState): Promise<ExprValue> {
  if (raw === undefined || raw === "") return null;
  if (raw.trimStart().startsWith("=")) return evaluateAsync(raw, st);
  return raw;
}

const literal = (v: ExprValue) =>
  v === null ? "Null" : typeof v === "boolean" ? (v ? "True" : "False") : typeof v === "number" ? String(v) : `"${String(v).replace(/"/g, '""')}"`;

/**
 * A Where Condition or SQL statement with its references to open forms and variables replaced by
 * their values now, so it still works after this form closes (or the record moves).
 */
export function freezeReferences(text: string, evaluate: (e: string) => ExprValue): string {
  return text.replace(
    /\[?\b(?:Forms|TempVars|LocalVars)\b\]?(?:\s*[!.]\s*(?:\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*))+/gi,
    (ref) => {
      try {
        return literal(evaluate(ref));
      } catch {
        return ref;
      }
    },
  );
}

/** The form an action acts on: the one named, else the one running the macro. */
function targetForm(name: string | undefined, st: RunState): FormHandle {
  if (name && name.trim()) {
    const f = openForm(name);
    if (!f) throw new MacroActionError(`The form '${bare(name)}' isn't open.`);
    return f;
  }
  if (!st.env.form) throw new MacroActionError("There's no form to act on. Name the form (Object Name), or run this from a form's button.");
  return st.env.form;
}

function findByName<T extends { id: string; name: string }>(list: readonly T[] | undefined, name: string, what: string): T {
  const n = bare(name).toLowerCase();
  if (!n) throw new MacroActionError(`Choose the ${what}.`);
  const hit = list?.find((x) => x.name.toLowerCase() === n);
  if (!hit) throw new MacroActionError(`There's no ${what} named '${bare(name)}'.`);
  return hit;
}

const yes = (v: string) => /^(yes|true|on|-1|1)$/i.test(v.trim());

async function runNamed(macroName: string, st: RunState) {
  if (st.depth > 20) throw new MacroActionError("Macros call each other too deeply (RunMacro loop?).");
  const raw = bare(macroName);
  const local = st.submacros.get(raw.toLowerCase());
  let steps: readonly MacroStep[];
  let submacros = st.submacros;
  if (local && !raw.includes(".")) steps = local;
  else {
    const [mName, sub] = raw.split(".");
    const m = findByName(st.env.doc().macros, mName, "macro");
    submacros = submacrosOf(m.steps);
    if (sub) {
      const s = submacros.get(sub.toLowerCase());
      if (!s) throw new MacroActionError(`The macro '${m.name}' has no submacro named '${sub}'.`);
      steps = s;
    } else steps = m.steps;
  }
  const inner: RunState = { ...st, submacros, depth: st.depth + 1, onError: { mode: "fail" } };
  try {
    await runSteps(steps, inner);
  } catch (e) {
    if (!(e instanceof Stop) || e.all) throw e;
  } finally {
    st.warnings = inner.warnings;
    st.cancelled ||= inner.cancelled;
  }
}

async function runAction(action: string, a: Record<string, string>, st: RunState): Promise<void> {
  const { env } = st;
  const doc = env.doc();
  switch (action) {
    case "OpenForm": {
      const f = findByName(doc.forms, await argText(a.FormName, st), "form");
      const view = await argText(a.View, st);
      const where = a.WhereCondition?.trim() ? freezeReferences(await argText(a.WhereCondition, st), env.evaluate) : undefined;
      const openArgs = a.OpenArgs?.trim() ? await argText(a.OpenArgs, st) : undefined;
      env.open("form", f.id, /design/i.test(view) ? "design" : undefined, { where, dataMode: await argText(a.DataMode, st) || undefined, ...(openArgs ? { openArgs } : {}) });
      // A dialog: the macro goes on once it's closed (then requeries, finds the new record…).
      if (/dialog|^3$/i.test(await argText(a.WindowMode, st)) && env.waitClosed) await env.waitClosed("form", f.id);
      return;
    }
    case "OpenReport": {
      const r = findByName(doc.reports, await argText(a.ReportName, st), "report");
      const view = await argText(a.View, st);
      const where = a.WhereCondition?.trim() ? freezeReferences(await argText(a.WhereCondition, st), env.evaluate) : undefined;
      return env.open("report", r.id, /design/i.test(view) ? "design" : undefined, { where, print: /^print$/i.test(view.trim()) });
    }
    case "OpenTable": {
      const t = findByName(doc.tables, await argText(a.TableName, st), "table");
      return env.open("table", t.id, /design/i.test(await argText(a.View, st)) ? "design" : undefined, {});
    }
    case "OpenQuery": {
      const q = findByName(doc.queries, await argText(a.QueryName, st), "query");
      const view = await argText(a.View, st);
      if (!/design|sql/i.test(view) && (await env.runActionQuery(q.id, st.warnings))) return;
      return env.open("query", q.id, /design/i.test(view) ? "design" : /sql/i.test(view) ? "sql" : undefined, {});
    }
    case "CloseWindow": {
      const type = (await argText(a.ObjectType, st)).toLowerCase();
      const name = await argText(a.ObjectName, st);
      if (!type || !name.trim()) {
        if (st.env.form) return st.env.form.close();
        return;
      }
      const kind = (["form", "report", "table", "query"] as const).find((k) => k === type);
      if (!kind) return;
      const list = { form: doc.forms, report: doc.reports, table: doc.tables, query: doc.queries }[kind];
      const o = list.find((x) => x.name.toLowerCase() === bare(name).toLowerCase());
      if (!o) return;
      // Closing the form the macro belongs to ends the macro (its later actions have nothing to act on).
      if (kind === "form" && st.env.form && st.env.form.name.toLowerCase() === o.name.toLowerCase()) {
        st.env.form.close();
        throw new Stop(false);
      }
      env.close(kind, o.id);
      return;
    }
    case "GoToRecord": {
      const f = targetForm(await argText(a.ObjectName, st), st);
      const off = (await argText(a.Offset, st)).trim();
      const n = off === "" ? 1 : Number(off);
      if (!Number.isFinite(n)) throw new MacroActionError(`The Offset '${off}' isn't a number.`);
      return f.goToRecord(await argText(a.Record, st) || "Next", n);
    }
    case "GoToControl": {
      const name = bare(await argText(a.ControlName, st));
      if (!targetForm(undefined, st).goToControl(name)) throw new MacroActionError(`There's no control named '${name}' on this form.`);
      return;
    }
    case "SaveRecord":
      return targetForm(undefined, st).saveRecord();
    case "DeleteRecord":
      return targetForm(undefined, st).deleteRecord();
    case "RefreshRecord":
    case "Requery":
      // Requery of one control (a combo box's list): lists here already follow the data, so there's nothing to do.
      if (action === "Requery" && a.ControlName?.trim()) return;
      targetForm(undefined, st).requery();
      // Let the form show the fresh records before the next action looks at them.
      return settle(60);
    case "ApplyFilter": {
      // A Where Condition of "" (as the templates' Clear Filter has) shows every record again.
      const w = (await argText(a.WhereCondition, st)).trim().replace(/^(""|'')$/, "");
      return targetForm(undefined, st).applyFilter(w ? freezeReferences(w, env.evaluate) : null);
    }
    case "ShowAllRecords":
      return targetForm(undefined, st).applyFilter(null);
    case "SearchForRecord": {
      const name = /form/i.test(await argText(a.ObjectType, st)) || !a.ObjectType ? await argText(a.ObjectName, st) : "";
      const where = freezeReferences(await argText(a.WhereCondition, st), env.evaluate).trim();
      if (!where) return;
      const which = (await argText(a.Record, st)) || "First";
      // A record just added (by a dialog this macro opened) may take a moment to reach the form.
      for (let tries = 0; ; tries++) {
        if (targetForm(name, st).searchForRecord(where, which)) return;
        if (tries >= 10) break;
        await settle(100);
      }
      env.status("No record matches.");
      return;
    }
    case "FollowHyperlink": {
      const url = (await argText(a.Address, st)).trim();
      if (!url) return;
      // Web pages, maps, e-mail and phone numbers only; a bare "www.…" is a web page.
      const full = /^www\./i.test(url) ? `https://${url}` : url;
      if (!/^(https?:|mailto:|tel:)/i.test(full)) throw new MacroActionError(`'${url}' isn't a web address this app can open.`);
      if (env.openUrl) env.openUrl(full);
      return;
    }
    case "EMailDatabaseObject": {
      const q: string[] = [];
      const add = async (k: string, v?: string) => {
        const t = (await argText(v, st)).trim();
        if (t) q.push(`${k}=${encodeURIComponent(t)}`);
      };
      await add("cc", a.Cc);
      await add("bcc", a.Bcc);
      await add("subject", a.Subject);
      await add("body", a.MessageText);
      // "Ann Lee [ann@example.com]" as Access writes recipients: the address in brackets.
      const to = (await argText(a.To, st))
        .split(";")
        .map((x) => (/\[([^\]]+@[^\]]+)\]/.exec(x)?.[1] ?? x).trim())
        .filter((x) => x.includes("@"))
        .join(",");
      env.openUrl?.(`mailto:${encodeURIComponent(to).replace(/%40/g, "@").replace(/%2C/g, ",")}${q.length ? `?${q.join("&")}` : ""}`);
      if (a.ObjectName?.trim()) env.status("The e-mail opens without the attachment: attaching a form or report isn't possible from the web.");
      return;
    }
    case "FindRecord": {
      const what = await argText(a.FindWhat, st);
      if (!targetForm(undefined, st).findRecord(what, await argText(a.Match, st) || "Whole Field")) env.status(`'${what}' wasn't found.`);
      return;
    }
    case "RunSQL": {
      const sql = (await argText(a.SQLStatement, st)).trim();
      if (!sql) throw new MacroActionError("The SQL Statement is empty.");
      return env.runSql(freezeReferences(sql, env.evaluate), st.warnings);
    }
    case "SetValue": {
      const item = await argText(a.Item, st);
      const value = await evaluateAsync(a.Expression ?? "", st);
      let path = item.split(/\s*[!.]\s*/).map(bare).filter(Boolean);
      // [Screen].[ActiveControl]: the control whose event runs the macro.
      if (path.length === 2 && /^screen$/i.test(path[0]) && /^activecontrol$/i.test(path[1])) {
        if (!st.env.activeControl) throw new MacroActionError("There's no active control to set.");
        path = [st.env.activeControl];
      }
      const [form, name] =
        path.length >= 3 && /^forms$/i.test(path[0]) ? [targetForm(path[1], st), path[2]] : [targetForm(undefined, st), path[path.length - 1]]; // [Form]![X], [Me]![X] and [X]: this form
      if (!name) throw new MacroActionError("Choose the Item to set.");
      const err = form.setValue(name, value);
      if (err) throw new MacroActionError(err);
      return;
    }
    case "SetProperty": {
      const name = bare(await argText(a.ControlName, st));
      const prop = await argText(a.Property, st) || "Enabled";
      const err = targetForm(undefined, st).setProperty(name, prop, await argValue(a.Value, st));
      if (err) throw new MacroActionError(err);
      return;
    }
    case "MessageBox": {
      if (await argText(a.Beep, st) !== "No") env.beep();
      return env.message(await argText(a.Message, st), await argText(a.Title, st), await argText(a.Type, st) || "None");
    }
    case "Beep":
      return env.beep();
    case "SetWarnings":
      st.warnings = yes(await argText(a.WarningsOn, st) || "No");
      return;
    case "SetTempVar": {
      const name = (await argText(a.Name, st)).trim();
      if (!name) throw new MacroActionError("Name the temporary variable.");
      tempVars.set(name.toLowerCase(), await evaluateAsync(a.Expression ?? "", st));
      return;
    }
    case "RemoveTempVar":
      tempVars.delete((await argText(a.Name, st)).trim().toLowerCase());
      return;
    case "RemoveAllTempVars":
      tempVars.clear();
      return;
    case "SetLocalVar": {
      const name = (await argText(a.Name, st)).trim();
      if (!name) throw new MacroActionError("Name the local variable.");
      st.locals.set(name.toLowerCase(), await evaluateAsync(a.Expression ?? "", st));
      return;
    }
    case "RunMacro": {
      const name = await argText(a.MacroName, st);
      const count = (await argText(a.RepeatCount, st)).trim();
      const times = count ? Math.max(0, Math.floor(Number(count) || 0)) : a.RepeatExpression?.trim() ? Infinity : 1;
      for (let i = 0; i < times && i < 10_000; i++) {
        if (a.RepeatExpression?.trim() && !truthy(await condition(a.RepeatExpression, st))) break;
        await runNamed(name, st);
      }
      return;
    }
    case "RunMenuCommand": {
      // Access's numbers for the commands (acCmd… constants), as older macros store them.
      const NUMBERED: Record<string, string> = { "97": "saverecord", "223": "deleterecord", "28": "recordsgotonew", "292": "undo", "18": "refresh", "144": "removefiltersort", "644": "removeallfilters", "340": "printobject", "58": "close" };
      const raw = (await argText(a.Command, st)).trim();
      const cmd = NUMBERED[raw] ?? raw.replace(/^acCmd/i, "").toLowerCase();
      const f = () => targetForm(undefined, st);
      switch (cmd) {
        case "saverecord": return f().saveRecord();
        case "deleterecord": return f().deleteRecord();
        case "recordsgotonew": return f().newRecord();
        case "undo": return f().undo();
        case "refresh": case "requery": return f().requery();
        case "removefiltersort": case "removeallfilters": return f().applyFilter(null);
        case "printobject": case "print": return env.print();
        case "close": case "closewindow": return f().close();
        case "find": return env.status("Use 🔍 Find under the form to look for records.");
        case "manageattachments":
          if (!f().pickPicture(st.env.activeControl)) env.status("This form has no picture to change.");
          return;
        case "unhidecolumns":
          if (!f().unhideColumns()) env.status("Unhide Columns works on a form showing a datasheet.");
          return;
        case "saveasoutlookcontact": return saveContactCard(f(), env);
        case "addcontactfromoutlook": return env.status("Adding contacts from Outlook isn't available on the web. Use External Data → Import to bring in a list of contacts.");
      }
      // New Labels (Access's Label Wizard): "NewLabels" or "NewLabels:Contacts" to start from that table or query.
      if (cmd === "newlabels" || cmd.startsWith("newlabels:")) {
        window.dispatchEvent(new CustomEvent(NEW_LABELS_EVENT, { detail: raw.includes(":") ? raw.slice(raw.indexOf(":") + 1).trim() : "" }));
        return;
      }
      throw new MacroActionError(`The command '${await argText(a.Command, st)}' isn't supported here.`);
    }
    case "OnError": {
      const g = (await argText(a.Goto, st) || "Fail").toLowerCase();
      st.onError = g === "next" ? { mode: "next" } : g.startsWith("macro") ? { mode: "macro", macro: await argText(a.MacroName, st) } : { mode: "fail" };
      return;
    }
    case "ClearMacroError":
      macroError.number = 0;
      macroError.description = "";
      macroError.actionName = "";
      return;
    case "StopMacro":
      throw new Stop(false);
    case "StopAllMacros":
      throw new Stop(true);
    case "CancelEvent":
      st.cancelled = true;
      return;
    case "PrintOut":
      return env.print();
    case "QuitAccess":
      env.closeAll();
      throw new Stop(true);
    case "Echo":
    case "DisplayHourglassPointer":
      return;
    case "RunCode":
      throw new MacroActionError(`VBA functions can't run here (${await argText(a.FunctionName, st) || "no function named"}).`);
  }
  throw new MacroActionError(MACRO_ACTIONS[action] ? `'${action}' isn't supported here yet.` : `'${action}' isn't an action this app can run.`);
}

/** Save As Outlook Contact: the record as a contact card (.vcf), which Outlook, phones and mail apps open. */
function saveContactCard(f: FormHandle, env: MacroEnv) {
  const get = (...names: string[]) => {
    for (const n of names) {
      const v = f.value(n);
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
    return "";
  };
  const esc = (t: string) => t.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
  const first = get("First Name", "FirstName");
  const last = get("Last Name", "LastName", "Surname");
  const company = get("Company", "Company Name");
  const full = [first, last].filter(Boolean).join(" ") || company;
  if (!full) return env.status("This record has no name to save as a contact.");
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `N:${esc(last)};${esc(first)};;;`, `FN:${esc(full)}`];
  const put = (key: string, ...names: string[]) => {
    const v = get(...names);
    if (v) lines.push(`${key}:${esc(v)}`);
  };
  put("ORG", "Company", "Company Name");
  put("TITLE", "Job Title", "Title");
  put("EMAIL;TYPE=INTERNET", "E-mail Address", "Email", "E-mail");
  put("TEL;TYPE=WORK", "Business Phone", "Work Phone");
  put("TEL;TYPE=HOME", "Home Phone");
  put("TEL;TYPE=CELL", "Mobile Phone", "Cell Phone");
  put("TEL;TYPE=FAX", "Fax Number", "Fax");
  const adr = [get("Address", "Street"), get("City"), get("State/Province", "State"), get("ZIP/Postal Code", "Zip/Postal Code", "Zip"), get("Country/Region", "Country")];
  if (adr.some(Boolean)) lines.push(`ADR;TYPE=WORK:;;${adr.map(esc).join(";")}`);
  put("URL", "Web Page", "Website");
  put("NOTE", "Notes");
  lines.push("END:VCARD");
  env.download?.(`${full.replace(/[\\/:*?"<>|]+/g, " ").trim() || "contact"}.vcf`, "text/vcard", lines.join("\r\n") + "\r\n");
}

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
