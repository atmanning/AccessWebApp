/**
 * Access macros and VBA event procedures, as this app's macros.
 *
 * Embedded and named macros come from jetdb already parsed (Access keeps them as XML): actions
 * with named arguments, If blocks, comments, groups and submacros. They map one to one.
 *
 * VBA is translated line by line where it does what a macro can: the DoCmd methods (OpenForm,
 * OpenReport, Close, GoToRecord, RunSQL, SetWarnings…), MsgBox, Me.Requery, setting a control's
 * value or properties, TempVars, local variables and If / ElseIf / Else. Expressions keep Access's
 * syntax with Me.X → [X] and Forms!F!C → [Forms]![F]![C], so DLookup, DSum, DCount, Nz… carry
 * over. Anything else is kept as a comment and reported, so nothing is silently lost.
 */
import { canonicalAction, type MacroStep } from "../../shared/macros.js";

// ---------------------------------------------------------------- jetdb macros

export interface JetStatement {
  kind: string;
  name?: string;
  text?: string;
  description?: string;
  condition?: string | null;
  arguments?: { name?: string; value?: unknown }[] | unknown[];
  statements?: JetStatement[];
  branches?: { condition?: string | null; statements?: JetStatement[] }[];
}

/** jetdb's parsed statements as macro steps. */
export function jetStatementsToSteps(list: readonly JetStatement[] | undefined): MacroStep[] {
  const out: MacroStep[] = [];
  for (const s of list ?? []) {
    switch (s.kind) {
      case "action": {
        if (!s.name) break;
        const args: Record<string, string> = {};
        for (const a of s.arguments ?? []) {
          if (a && typeof a === "object" && "name" in a && a.name) {
            const v = (a as { value?: unknown }).value;
            if (v !== null && v !== undefined && v !== "") args[String(a.name).slice(0, 64)] = String(v).slice(0, 8000);
          }
        }
        out.push({ kind: "action", action: canonicalAction(s.name).slice(0, 64), ...(Object.keys(args).length ? { args } : {}) });
        break;
      }
      case "comment":
        out.push({ kind: "comment", text: String(s.text ?? "").slice(0, 4000) });
        break;
      case "if":
        out.push({
          kind: "if",
          branches: (s.branches ?? []).slice(0, 50).map((b) => ({
            ...(b.condition !== null && b.condition !== undefined ? { condition: String(b.condition).slice(0, 4000) } : {}),
            steps: jetStatementsToSteps(b.statements),
          })),
        });
        break;
      case "group":
        out.push({ kind: "group", name: String(s.description ?? s.name ?? "Group").slice(0, 200), steps: jetStatementsToSteps(s.statements) });
        break;
      case "submacro":
        out.push({ kind: "submacro", name: String(s.name ?? "Submacro").slice(0, 64), steps: jetStatementsToSteps(s.statements) });
        break;
      default:
        out.push({ kind: "comment", text: `Not imported: a ${s.kind} element of the Access macro.` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- VBA

/** The body of `Sub <name>(…) … End Sub` in a module, or null. */
export function vbaProcedure(code: string, name: string): string | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^[ \\t]*(?:(?:Private|Public)\\s+)?Sub\\s+${esc}\\s*\\([^)\\r\\n]*\\)[^\\r\\n]*\\r?\\n([\\s\\S]*?)^[ \\t]*End\\s+Sub\\b`, "im").exec(code);
  return m ? m[1] : null;
}

type Tok = { k: "str" | "num" | "word" | "br" | "op" | "ws" | "date"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      let v = "";
      for (;;) {
        if (j >= src.length) throw new VbaError("A string isn't closed.");
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            v += '"';
            j += 2;
            continue;
          }
          break;
        }
        v += src[j++];
      }
      out.push({ k: "str", v });
      i = j + 1;
    } else if (c === "[") {
      const j = src.indexOf("]", i);
      if (j < 0) throw new VbaError("A [ isn't closed.");
      out.push({ k: "br", v: src.slice(i + 1, j) });
      i = j + 1;
    } else if (c === "#") {
      const j = src.indexOf("#", i + 1);
      if (j < 0) throw new VbaError("A date isn't closed.");
      out.push({ k: "date", v: src.slice(i, j + 1) });
      i = j + 1;
    } else if (/\s/.test(c)) {
      let j = i;
      while (j < src.length && /\s/.test(src[j])) j++;
      out.push({ k: "ws", v: " " });
      i = j;
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?[#!@&%]?/.exec(src.slice(i))!;
      out.push({ k: "num", v: m[0].replace(/[#!@&%]$/, "") });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*\$?/.exec(src.slice(i))!;
      out.push({ k: "word", v: m[0].replace(/\$$/, "") });
      i += m[0].length;
    } else {
      const two = src.slice(i, i + 2);
      if (two === "<>" || two === "<=" || two === ">=" || two === ":=") {
        out.push({ k: "op", v: two });
        i += 2;
      } else {
        out.push({ k: "op", v: c });
        i++;
      }
    }
  }
  return out;
}

export class VbaError extends Error {}

const VB_CONSTANTS: Record<string, string> = {
  vbcrlf: "Chr(13) & Chr(10)",
  vbnewline: "Chr(13) & Chr(10)",
  vbcr: "Chr(13)",
  vblf: "Chr(10)",
  vbtab: "Chr(9)",
  vbnullstring: '""',
  vbyes: "6",
  vbno: "7",
  vbok: "1",
  vbokonly: "0",
  vbokcancel: "1",
  vbabortretryignore: "2",
  vbyesnocancel: "3",
  vbyesno: "4",
  vbretrycancel: "5",
  vbcritical: "16",
  vbquestion: "32",
  vbexclamation: "48",
  vbinformation: "64",
  vbdefaultbutton1: "0",
  vbdefaultbutton2: "256",
  vbdefaultbutton3: "512",
  vbapplicationmodal: "0",
  vbsystemmodal: "4096",
  vbabort: "3",
  vbretry: "4",
  vbignore: "5",
  vbuppercase: "1",
  vblowercase: "2",
  vbpropercase: "3",
  vbcancel: "2",
  nothing: "Null",
  empty: "Null",
};
const KEYWORDS = new Set(["and", "or", "not", "mod", "like", "is", "null", "true", "false", "xor", "eqv", "imp", "between", "in"]);
const NO_ARG_FUNCTIONS = new Set(["date", "now", "time"]);

/** Converts what follows a word into a chain: Me.X, Forms!F!C, Forms("F").C, TempVars("x")… */
function readChain(t: Tok[], i: number): { parts: string[]; end: number; viaStringIndex: boolean } {
  const parts = [t[i].v];
  let j = i + 1;
  let viaStringIndex = false;
  for (;;) {
    const a = t[j];
    if (a?.k === "op" && (a.v === "." || a.v === "!") && (t[j + 1]?.k === "word" || t[j + 1]?.k === "br")) {
      parts.push(t[j + 1].v);
      j += 2;
      continue;
    }
    // Forms("Orders"), TempVars("x"), Me("Name"), Controls("x")
    if (a?.k === "op" && a.v === "(" && t[j + 1]?.k === "str" && t[j + 2]?.k === "op" && t[j + 2].v === ")" && /^(forms|reports|tempvars|me|controls|item)$/i.test(parts[parts.length - 1])) {
      if (/^(controls|item)$/i.test(parts[parts.length - 1])) parts.pop();
      parts.push(t[j + 1].v);
      viaStringIndex = true;
      j += 3;
      continue;
    }
    break;
  }
  return { parts, end: j, viaStringIndex };
}

/** A VBA expression in Access expression syntax. `locals` are Dim'd variables ([LocalVars]![x]). */
export interface Scope {
  /** Dim'd variables of the procedure: [LocalVars]![x]. */
  locals: Set<string>;
  /** The form's controls and fields, when known: other bare names are variables kept in [TempVars]. */
  names?: ReadonlySet<string>;
}

export function vbaExpr(src: string, scope: Scope = { locals: new Set() }): string {
  const t = tokenize(src.trim());
  let out = "";
  const q = (n: string) => `[${n}]`;
  for (let i = 0; i < t.length; ) {
    const tok = t[i];
    if (tok.k === "str") {
      out += `"${tok.v.replace(/"/g, '""')}"`;
      i++;
    } else if (tok.k === "word" || tok.k === "br") {
      const { parts, end } = readChain(t, i);
      const head = parts[0].toLowerCase();
      // Drop .Value / .Text / .Column-less defaults: [X].[Value] is [X].
      while (parts.length > 2 && /^(value|text)$/i.test(parts[parts.length - 1])) parts.pop();
      const next = t[end]?.k === "ws" ? t[end + 1] : t[end];
      if (tok.k === "word" && head === "me") {
        if (parts.length === 1) throw new VbaError("Me on its own can't be used in an expression.");
        if (parts.length > 2 && !/^(value|text)$/i.test(parts[2])) throw new VbaError(`Me.${parts.slice(1).join(".")} can't be read in a macro.`);
        if (/^(newrecord|dirty|recordsetclone|recordset|openargs|filter|filteron|name)$/i.test(parts[1])) throw new VbaError(`Me.${parts[1]} isn't available in macros.`);
        out += q(parts[1]);
      } else if (tok.k === "word" && (head === "forms" || head === "reports") && parts.length >= 2) {
        out += [head === "forms" ? "[Forms]" : "[Reports]", ...parts.slice(1).filter((p, k) => !(k >= 2 && /^(value|text|form)$/i.test(p))).map(q)].join("!");
      } else if (tok.k === "word" && head === "tempvars" && parts.length === 2) {
        out += `[TempVars]![${parts[1]}]`;
      } else if (parts.length === 1 && tok.k === "word") {
        const w = tok.v.toLowerCase();
        if (scope.locals.has(w)) out += `[LocalVars]![${tok.v}]`;
        else if (w in VB_CONSTANTS) out += VB_CONSTANTS[w];
        else if (KEYWORDS.has(w)) out += tok.v;
        else if (next?.k === "op" && next.v === "(") out += tok.v; // a function call
        else if (NO_ARG_FUNCTIONS.has(w)) out += `${tok.v}()`;
        else if (/^(ac|vb)[A-Z]/.test(tok.v)) throw new VbaError(`The constant ${tok.v} isn't known here.`);
        else if (scope.names && !scope.names.has(w)) out += `[TempVars]![${tok.v}]`; // a module or global variable
        else out += q(tok.v); // a control or field of the form
      } else if (parts.length === 1) {
        out += q(tok.v);
      } else {
        // In VBA, a.b is an object's property (a recordset, Err, Screen…), which macros can't read.
        if (tok.k === "word") throw new VbaError(`${parts.join(".")} can't be used in a macro.`);
        out += parts.map(q).join(".");
      }
      i = end;
    } else if (tok.k === "op" && tok.v === ":=") {
      throw new VbaError("Named arguments can't be used in an expression.");
    } else {
      out += tok.v;
      i++;
    }
  }
  return out.trim();
}

/** Splits arguments on top-level commas; named ones (Name:=value) come back by name. */
function splitArgs(src: string): { positional: string[]; named: Map<string, string> } {
  const positional: string[] = [];
  const named = new Map<string, string>();
  let depth = 0;
  let cur = "";
  let inStr = false;
  const push = () => {
    const m = /^\s*([A-Za-z_]\w*)\s*:=\s*([\s\S]*)$/.exec(cur);
    if (m) named.set(m[1].toLowerCase(), m[2].trim());
    else positional.push(cur.trim());
    cur = "";
  };
  for (const ch of src) {
    if (ch === '"') inStr = !inStr;
    if (!inStr) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        push();
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim() || positional.length || named.size) push();
  return { positional, named };
}

/** VBA's ac… constants for macro arguments, by argument. */
const CONSTANTS: Record<string, Record<string, string>> = {
  View: { acnormal: "Form", acviewnormal: "Form", acdesign: "Design", acviewdesign: "Design", acpreview: "Print Preview", acviewpreview: "Print Preview", acformds: "Datasheet", acviewreport: "Report", acviewlayout: "Form", "0": "Form", "1": "Design", "2": "Print Preview", "3": "Datasheet" },
  DataMode: { acformadd: "Add", acformedit: "Edit", acformreadonly: "Read Only", acformpropertysettings: "", acadd: "Add", acedit: "Edit", acreadonly: "Read Only", "0": "Add", "1": "Edit", "2": "Read Only", "-1": "" },
  Record: { acnext: "Next", acprevious: "Previous", acfirst: "First", aclast: "Last", acgoto: "Go To", acnewrec: "New", "0": "Previous", "1": "Next", "2": "First", "3": "Last", "4": "Go To", "5": "New" },
  ObjectType: { acform: "Form", acreport: "Report", actable: "Table", acquery: "Query", acmacro: "Macro", acdefault: "", acactivedataobject: "", "2": "Form", "3": "Report", "0": "Table", "1": "Query", "-1": "" },
  WarningsOn: { true: "Yes", false: "No", "-1": "Yes", "0": "No", yes: "Yes", no: "No" },
  Match: { acentire: "Whole Field", acanywhere: "Any Part of Field", acstart: "Start of Field" },
};

interface DoCmdDef {
  action: string;
  params: string[];
  /** How each argument is kept: as text (= when computed), as an expression, or a constant. */
  kinds?: Record<string, "expr" | "text">;
}
const DOCMD: Record<string, DoCmdDef> = {
  openform: { action: "OpenForm", params: ["FormName", "View", "FilterName", "WhereCondition", "DataMode", "WindowMode", "OpenArgs"] },
  openreport: { action: "OpenReport", params: ["ReportName", "View", "FilterName", "WhereCondition", "WindowMode", "OpenArgs"] },
  opentable: { action: "OpenTable", params: ["TableName", "View", "DataMode"] },
  openquery: { action: "OpenQuery", params: ["QueryName", "View", "DataMode"] },
  close: { action: "CloseWindow", params: ["ObjectType", "ObjectName", "Save"] },
  gotorecord: { action: "GoToRecord", params: ["ObjectType", "ObjectName", "Record", "Offset"] },
  gotocontrol: { action: "GoToControl", params: ["ControlName"] },
  runsql: { action: "RunSQL", params: ["SQLStatement", "UseTransaction"] },
  setwarnings: { action: "SetWarnings", params: ["WarningsOn"] },
  applyfilter: { action: "ApplyFilter", params: ["FilterName", "WhereCondition", "ControlName"] },
  showallrecords: { action: "ShowAllRecords", params: [] },
  requery: { action: "Requery", params: ["ControlName"] },
  refreshrecord: { action: "RefreshRecord", params: [] },
  runcommand: { action: "RunMenuCommand", params: ["Command"] },
  runmacro: { action: "RunMacro", params: ["MacroName", "RepeatCount", "RepeatExpression"], kinds: { RepeatExpression: "expr" } },
  findrecord: { action: "FindRecord", params: ["FindWhat", "Match", "MatchCase", "Search", "SearchAsFormatted", "OnlyCurrentField", "FindFirst"] },
  printout: { action: "PrintOut", params: [] },
  beep: { action: "Beep", params: [] },
  quit: { action: "QuitAccess", params: [] },
  cancelevent: { action: "CancelEvent", params: [] },
  settempvar: { action: "SetTempVar", params: ["Name", "Expression"], kinds: { Expression: "expr" } },
};
/** DoCmd methods that do nothing here and can be left out. */
const DOCMD_IGNORED = new Set(["hourglass", "echo", "maximize", "minimize", "restore", "movesize", "save", "repaintobject", "selectobject", "setmenuitem", "showtoolbar", "navigateto", "lockNavigationPane".toLowerCase()]);
const KEEP_ARGS = new Set(["FormName", "View", "WhereCondition", "DataMode", "ReportName", "TableName", "QueryName", "ObjectType", "ObjectName", "Record", "Offset", "ControlName", "SQLStatement", "WarningsOn", "Command", "MacroName", "RepeatCount", "RepeatExpression", "FindWhat", "Match", "Name", "Expression"]);

/** A literal argument as its text; a computed one as =expression. */
function textArg(raw: string, scope: Scope): string {
  const t = raw.trim();
  const lit = /^"((?:[^"]|"")*)"$/.exec(t);
  if (lit) return lit[1].replace(/""/g, '"');
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  return `=${vbaExpr(t, scope)}`;
}

function docmdStep(method: string, argSrc: string, scope: Scope): MacroStep | null {
  const m = method.toLowerCase();
  if (DOCMD_IGNORED.has(m)) return null;
  const def = DOCMD[m];
  if (!def) throw new VbaError(`DoCmd.${method} isn't supported here.`);
  const { positional, named } = splitArgs(argSrc.trim().replace(/^\(([\s\S]*)\)$/, "$1"));
  const args: Record<string, string> = {};
  def.params.forEach((p, i) => {
    const raw = named.get(p.toLowerCase()) ?? positional[i];
    if (raw === undefined || raw.trim() === "" || !KEEP_ARGS.has(p)) return;
    const consts = CONSTANTS[p];
    const key = raw.trim().toLowerCase();
    if (consts && key in consts) {
      if (consts[key]) args[p] = consts[key];
      return;
    }
    if (p === "Command") {
      const c = /^acCmd(\w+)$/i.exec(raw.trim());
      if (!c) throw new VbaError(`RunCommand ${raw.trim()} isn't supported here.`);
      args[p] = c[1];
      return;
    }
    if (/^ac[A-Z]/.test(raw.trim())) throw new VbaError(`The constant ${raw.trim()} isn't known here.`);
    args[p] = def.kinds?.[p] === "expr" ? vbaExpr(raw, scope) : textArg(raw, scope);
  });
  return { kind: "action", action: def.action, ...(Object.keys(args).length ? { args } : {}) };
}

function msgBoxStep(argSrc: string, scope: Scope): MacroStep {
  const { positional, named } = splitArgs(argSrc.trim().replace(/^\(([\s\S]*)\)$/, "$1"));
  const prompt = named.get("prompt") ?? positional[0] ?? '""';
  const buttons = (named.get("buttons") ?? positional[1] ?? "").toLowerCase();
  const title = named.get("title") ?? positional[2];
  const type = /vbcritical|\b16\b/.test(buttons) ? "Critical" : /vbquestion|\b32\b/.test(buttons) ? "Warning?" : /vbexclamation|\b48\b/.test(buttons) ? "Warning!" : /vbinformation|\b64\b/.test(buttons) ? "Information" : "";
  const args: Record<string, string> = { Message: textArg(prompt, scope) };
  if (type) args.Type = type;
  if (title?.trim()) args.Title = textArg(title, scope);
  return { kind: "action", action: "MessageBox", args };
}

/** Logical lines: continuations joined, comments removed, `a: b` split. */
function logicalLines(body: string): string[] {
  const joined = body.replace(/[ \t]_[ \t]*\r?\n/g, " ");
  const out: string[] = [];
  for (const raw of joined.split(/\r?\n/)) {
    let line = "";
    let inStr = false;
    const parts: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '"') inStr = !inStr;
      if (!inStr && ch === "'") break;
      if (!inStr && ch === ":" && raw[i + 1] !== "=" && !/^\s*\w+$/.test(line + "") ) {
        parts.push(line);
        line = "";
        continue;
      }
      line += ch;
    }
    parts.push(line);
    for (const p of parts) {
      const t = p.trim();
      if (t && !/^Rem\b/i.test(t)) out.push(t);
    }
  }
  return out;
}

export interface VbaConversion {
  steps: MacroStep[];
  /** Lines that couldn't be converted (kept as comments in the steps). */
  unconverted: string[];
}

/** Converts an event procedure's body to macro steps. */
export function vbaToSteps(body: string, opts: { module?: string; names?: ReadonlySet<string> } = {}, depth = 0): VbaConversion {
  const module = opts.module ?? "";
  const lines = logicalLines(body);
  const unconverted: string[] = [];
  const scope: Scope = { locals: new Set(), names: opts.names };
  // Stack of step lists: the procedure, then each open If branch.
  const root: MacroStep[] = [];
  const ifs: { step: Extract<MacroStep, { kind: "if" }>; outer: MacroStep[] }[] = [];
  let cur = root;
  let pendingFilter: string | null = null;
  const keep = (line: string, why?: string) => {
    unconverted.push(line);
    cur.push({ kind: "comment", text: `VBA not converted${why ? ` (${why})` : ""}: ${line}`.slice(0, 4000) });
  };
  const add = (s: MacroStep | null) => s && cur.push(s);
  const act = (action: string, args?: Record<string, string>): MacroStep => ({ kind: "action", action, ...(args && Object.keys(args).length ? { args } : {}) });
  /**
   * An If's condition. One that can't be converted still opens its block (so End If matches), with
   * a condition that stops the macro when reached: its steps must never run unchecked.
   */
  const condition = (src: string, line: string) => {
    try {
      return vbaExpr(src, scope);
    } catch (e) {
      unconverted.push(line);
      return `NotConvertedFromVBA(${JSON.stringify(src.replace(/"/g, "'").slice(0, 300))})`;
    }
  };
  const BLOCK = /^(Select\s+Case|For\b|Do\b|While\b|With\b)/i;
  const BLOCK_END = /^(End\s+Select|Next\b|Loop\b|Wend\b|End\s+With)/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    try {
      // A label: the rest is the wizard's exit / error-handling code (Exit_X: Exit Sub, Err_X: MsgBox Err.Description).
      if (/^[A-Za-z_]\w*:$/.test(line)) break;
      if (/^Exit\s+Sub$/i.test(line)) {
        add(act("StopMacro"));
        continue;
      }
      if (/^(Dim|Static|Private|Const)\s/i.test(line)) {
        for (const d of line.replace(/^(Dim|Static|Private|Const)\s+/i, "").split(",")) {
          const n = /^\s*([A-Za-z_]\w*)/.exec(d)?.[1];
          if (n) scope.locals.add(n.toLowerCase());
        }
        if (/^Const\s/i.test(line)) keep(line, "constants");
        continue;
      }
      if ((m = /^On\s+Error\s+(Resume\s+Next|GoTo\s+0|GoTo\s+\w+)$/i.exec(line))) {
        if (/resume/i.test(m[1])) add(act("OnError", { Goto: "Next" }));
        else if (/goto\s+0/i.test(m[1])) add(act("OnError", { Goto: "Fail" }));
        // On Error GoTo Err_Handler: failing shows the message and stops, as the handler did.
        continue;
      }
      if (BLOCK.test(line)) {
        let depth = 1;
        const start = line;
        while (++i < lines.length && depth > 0) {
          if (BLOCK.test(lines[i])) depth++;
          else if (BLOCK_END.test(lines[i])) depth--;
        }
        i--;
        keep(`${start} …`, "loops and Select Case");
        continue;
      }
      // If blocks.
      if ((m = /^If\s+([\s\S]+?)\s+Then$/i.exec(line))) {
        const step: Extract<MacroStep, { kind: "if" }> = { kind: "if", branches: [{ condition: condition(m[1], line), steps: [] }] };
        cur.push(step);
        ifs.push({ step, outer: cur });
        cur = step.branches[0].steps;
        continue;
      }
      if ((m = /^ElseIf\s+([\s\S]+?)\s+Then$/i.exec(line)) && ifs.length) {
        const top = ifs[ifs.length - 1].step;
        top.branches.push({ condition: condition(m[1], line), steps: [] });
        cur = top.branches[top.branches.length - 1].steps;
        continue;
      }
      if (/^Else$/i.test(line) && ifs.length) {
        const top = ifs[ifs.length - 1].step;
        top.branches.push({ steps: [] });
        cur = top.branches[top.branches.length - 1].steps;
        continue;
      }
      if (/^End\s*If$/i.test(line) && ifs.length) {
        cur = ifs.pop()!.outer;
        continue;
      }
      // One-line If: If x Then stmt [Else stmt]
      if ((m = /^If\s+([\s\S]+?)\s+Then\s+([\s\S]+?)(?:\s+Else\s+([\s\S]+))?$/i.exec(line))) {
        const thenPart = vbaToSteps(m[2], opts, depth);
        const elsePart = m[3] ? vbaToSteps(m[3], opts, depth) : null;
        unconverted.push(...thenPart.unconverted, ...(elsePart?.unconverted ?? []));
        cur.push({ kind: "if", branches: [{ condition: condition(m[1], line), steps: thenPart.steps }, ...(elsePart ? [{ steps: elsePart.steps }] : [])] });
        continue;
      }
      const stmt = line.replace(/^Call\s+/i, "");
      // Another procedure of the form's module, without arguments: its steps, in place.
      if ((m = /^([A-Za-z_]\w*)(?:\s*\(\s*\))?$/.exec(stmt)) && module && depth < 3 && !/^(beep|stop|end|exit|resume|return)$/i.test(m[1])) {
        const sub = vbaProcedure(module, m[1]);
        if (sub !== null) {
          const inner = vbaToSteps(sub, opts, depth + 1);
          unconverted.push(...inner.unconverted);
          // Its Exit Sub ends only that procedure: drop a trailing StopMacro, keep it a group.
          cur.push({ kind: "group", name: `${m[1]} (from VBA)`, steps: inner.steps });
          continue;
        }
      }
      if ((m = /^DoCmd\.(\w+)\s*([\s\S]*)$/i.exec(stmt))) {
        add(docmdStep(m[1], m[2], scope));
        continue;
      }
      if ((m = /^(?:VBA\.)?MsgBox\b\s*([\s\S]*)$/i.exec(stmt))) {
        add(msgBoxStep(m[1], scope));
        continue;
      }
      if (/^(Beep|DoCmd\.Beep)$/i.test(stmt)) {
        add(act("Beep"));
        continue;
      }
      if (/^Application\.(Echo|Quit)\b/i.test(stmt)) {
        if (/quit/i.test(stmt)) add(act("QuitAccess"));
        continue;
      }
      if ((m = /^Me\.(Requery|Refresh|Recalc|Repaint|Undo|SetFocus)$/i.exec(stmt))) {
        const w = m[1].toLowerCase();
        if (w === "requery") add(act("Requery"));
        else if (w === "refresh" || w === "recalc") add(act("RefreshRecord"));
        else if (w === "undo") add(act("RunMenuCommand", { Command: "Undo" }));
        continue;
      }
      if ((m = /^(?:Me[.!])?(\[[^\]]+\]|\w+)\.(Requery|SetFocus|Undo|Dropdown)$/i.exec(stmt)) && !/^(rs|rst|db|crs|docmd)$/i.test(m[1])) {
        const name = m[1].replace(/^\[|\]$/g, "");
        const w = m[2].toLowerCase();
        if (w === "requery") add(act("Requery", { ControlName: name }));
        else if (w === "setfocus") add(act("GoToControl", { ControlName: name }));
        continue;
      }
      if ((m = /^Me\.Dirty\s*=\s*False$/i.exec(stmt))) {
        add(act("SaveRecord"));
        continue;
      }
      if ((m = /^Me\.Filter\s*=\s*([\s\S]+)$/i.exec(stmt))) {
        pendingFilter = m[1];
        continue;
      }
      if ((m = /^Me\.FilterOn\s*=\s*(\w+)$/i.exec(stmt))) {
        if (/^(true|-1)$/i.test(m[1]) && pendingFilter) add(act("ApplyFilter", { WhereCondition: textArg(pendingFilter, scope) }));
        else if (/^(false|0)$/i.test(m[1])) add(act("ShowAllRecords"));
        continue;
      }
      if ((m = /^TempVars\.Add\s+([\s\S]+)$/i.exec(stmt)) || (m = /^TempVars\.Add\s*\(([\s\S]+)\)$/i.exec(stmt))) {
        const { positional } = splitArgs(m[1]);
        add(act("SetTempVar", { Name: textArg(positional[0] ?? '""', scope), Expression: vbaExpr(positional[1] ?? "Null", scope) }));
        continue;
      }
      if ((m = /^TempVars\.Remove\s*\(?\s*("[^"]*")\s*\)?$/i.exec(stmt))) {
        add(act("RemoveTempVar", { Name: textArg(m[1], scope) }));
        continue;
      }
      if (/^TempVars\.RemoveAll$/i.test(stmt)) {
        add(act("RemoveAllTempVars"));
        continue;
      }
      // Assignments: TempVars, local variables, control properties, control values.
      if ((m = /^(?:Let\s+)?((?:\[[^\]]+\]|[\w.!"() ])+?)\s*=\s*([\s\S]+)$/i.exec(stmt)) && !/^Set\s/i.test(stmt)) {
        const target = m[1].trim();
        const value = m[2];
        let t: RegExpExecArray | null;
        if ((t = /^TempVars(?:!(\w+)|\("([^"]+)"\)|!\[([^\]]+)\]|\.Item\("([^"]+)"\))$/i.exec(target))) {
          add(act("SetTempVar", { Name: t[1] ?? t[2] ?? t[3] ?? t[4], Expression: vbaExpr(value, scope) }));
          continue;
        }
        if (/^[A-Za-z_]\w*$/.test(target) && scope.locals.has(target.toLowerCase())) {
          add(act("SetLocalVar", { Name: target, Expression: vbaExpr(value, scope) }));
          continue;
        }
        if ((t = /^(?:Me[.!])?(\[[^\]]+\]|\w+)\.(Visible|Enabled|Locked|Caption|ForeColor|BackColor|Value)$/i.exec(target)) && !/^me$/i.test(t[1])) {
          const name = t[1].replace(/^\[|\]$/g, "");
          const prop = t[2][0].toUpperCase() + t[2].slice(1).toLowerCase();
          add(act("SetProperty", { ControlName: name, Property: prop === "Forecolor" ? "ForeColor" : prop === "Backcolor" ? "BackColor" : prop, Value: textArg(value, scope) }));
          continue;
        }
        if ((t = /^Me[.!](\[[^\]]+\]|\w+)$/i.exec(target)) || (t = /^(\[[^\]]+\]|[A-Za-z_]\w*)$/.exec(target))) {
          const name = t[1].replace(/^\[|\]$/g, "");
          if (/^(filter|filteron|dirty|recordsource|allowedits|allowadditions|allowdeletions|caption|orderby|orderbyon)$/i.test(name) && /^Me/i.test(target)) throw new VbaError(`Setting Me.${name} isn't supported here.`);
          if (!/^Me/i.test(target) && !/^\[/.test(target) && scope.names && !scope.names.has(name.toLowerCase())) {
            // Not a control or field: a variable of the module (or a global one), kept as a temporary variable.
            add(act("SetTempVar", { Name: name, Expression: vbaExpr(value, scope) }));
            continue;
          }
          add(act("SetValue", { Item: `[${name}]`, Expression: vbaExpr(value, scope) }));
          continue;
        }
        if ((t = /^Forms!(\[[^\]]+\]|\w+)!(\[[^\]]+\]|\w+)$/i.exec(target))) {
          const f = t[1].replace(/^\[|\]$/g, "");
          const c = t[2].replace(/^\[|\]$/g, "");
          add(act("SetValue", { Item: `[Forms]![${f}]![${c}]`, Expression: vbaExpr(value, scope) }));
          continue;
        }
      }
      throw new VbaError("");
    } catch (e) {
      if (!(e instanceof VbaError)) throw e;
      keep(line, e.message || undefined);
    }
  }
  // Drop a StopMacro at the very end (Exit Sub before the error handler).
  while (root.length && root[root.length - 1].kind === "action" && (root[root.length - 1] as { action: string }).action === "StopMacro") root.pop();
  return { steps: root, unconverted };
}
