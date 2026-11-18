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

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const decodeXml = (t: string) =>
  t.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) =>
    e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" : String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))),
  );

/** A small XML reader for Access's macro XML (elements, attributes, text; no DTDs). */
function parseXml(xml: string): XmlNode | null {
  const root: XmlNode = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[6] !== undefined) top.text += decodeXml(m[6]);
    else if (m[3]) {
      if (m[2]) {
        if (stack.length < 2 || top.tag !== m[3]) return null;
        stack.pop();
      } else {
        const attrs: Record<string, string> = {};
        for (const a of (m[4] ?? "").matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decodeXml(a[2] ?? a[3] ?? "");
        const node: XmlNode = { tag: m[3], attrs, children: [], text: "" };
        top.children.push(node);
        if (!m[5]) stack.push(node);
      }
    }
  }
  return stack.length === 1 ? root : null;
}

const child = (n: XmlNode, tag: string) => n.children.find((c) => c.tag === tag);

function xmlStatements(n: XmlNode | undefined): MacroStep[] {
  const out: MacroStep[] = [];
  for (const s of n?.children ?? []) {
    switch (s.tag) {
      case "Action": {
        const name = s.attrs.Name;
        if (!name) break;
        const args: Record<string, string> = {};
        for (const a of s.children) if (a.tag === "Argument" && a.attrs.Name && a.text !== "") args[a.attrs.Name.slice(0, 64)] = a.text.slice(0, 8000);
        out.push({ kind: "action", action: canonicalAction(name).slice(0, 64), ...(Object.keys(args).length ? { args } : {}) });
        break;
      }
      case "Comment":
        out.push({ kind: "comment", text: s.text.slice(0, 4000) });
        break;
      case "ConditionalBlock":
        out.push({
          kind: "if",
          branches: s.children
            .filter((b) => b.tag === "If" || b.tag === "ElseIf" || b.tag === "Else")
            .slice(0, 50)
            .map((b) => {
              const cond = child(b, "Condition")?.text;
              return { ...(b.tag !== "Else" && cond !== undefined ? { condition: cond.slice(0, 4000) } : {}), steps: xmlStatements(child(b, "Statements")) };
            }),
        });
        break;
      case "Group":
        out.push({ kind: "group", name: (s.attrs.Name || child(s, "Description")?.text || "Group").slice(0, 200), steps: xmlStatements(child(s, "Statements")) });
        break;
      case "Sub":
        out.push({ kind: "submacro", name: (s.attrs.Name || "Submacro").slice(0, 64), steps: xmlStatements(child(s, "Statements")) });
        break;
      default:
        out.push({ kind: "comment", text: `Not imported: a ${s.tag} element of the Access macro.` });
    }
  }
  return out;
}

/**
 * A macro's steps from Access's macro XML, with its submacros (the <Sub> elements after the main
 * statements, which jetdb's parsed statements leave out); null when the XML can't be read.
 */
export function macroXmlToSteps(xml: string | undefined | null): MacroStep[] | null {
  if (!xml) return null;
  const doc = parseXml(xml);
  const macro = doc?.children.find((c) => c.tag === "UserInterfaceMacro" || c.tag === "UserInterfaceMacros");
  if (!macro) return null;
  // A file with several macros (UserInterfaceMacros) keeps each in its own element.
  const one = macro.tag === "UserInterfaceMacros" ? macro.children.find((c) => c.tag === "UserInterfaceMacro") : macro;
  if (!one) return null;
  const steps = xmlStatements(child(one, "Statements"));
  for (const sub of one.children) if (sub.tag === "Sub") steps.push(...xmlStatements({ tag: "#", attrs: {}, text: "", children: [sub] }));
  return steps;
}

/** A jetdb macro's steps: from its XML when that reads, else jetdb's parsed statements. */
export function jetMacroSteps(m: { statements?: JetStatement[]; xml?: string | null }): MacroStep[] {
  try {
    const fromXml = macroXmlToSteps(m.xml);
    if (fromXml) return fromXml;
  } catch {
    /* fall back */
  }
  return jetStatementsToSteps(m.statements);
}

// ---------------------------------------------------------------- VBA

/** The body of `Sub <name>(…) … End Sub` in a module, or null. */
export function vbaProcedure(code: string, name: string): string | null {
  return findProcedure(code, name)?.body ?? null;
}

export interface VbaProcedure {
  name: string;
  kind: "sub" | "function";
  params: { name: string; optional: boolean; default?: string }[];
  body: string;
}

/** A Sub or Function in a module: its parameters and body. */
export function findProcedure(code: string, name: string): VbaProcedure | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(
    `^[ \\t]*(?:(?:Private|Public|Friend)\\s+)?(?:Static\\s+)?(Sub|Function)\\s+(${esc})\\s*\\(([^)\\r\\n]*(?:\\)[^)\\r\\n]*)?)\\)[^\\r\\n]*\\r?\\n([\\s\\S]*?)^[ \\t]*(?:\\d+\\s+)?End\\s+\\1\\b`,
    "im",
  ).exec(code);
  if (!m) return null;
  const params = m[3]
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const d = /^(Optional\s+)?(?:(?:ByVal|ByRef|ParamArray)\s+)?(\w+)(?:\(\))?(?:\s+As\s+[\w.]+)?(?:\s*=\s*(.+))?$/i.exec(x);
      return { name: d?.[2] ?? x, optional: !!d?.[1], ...(d?.[3] !== undefined ? { default: d[3].trim() } : {}) };
    });
  return { name: m[2], kind: m[1].toLowerCase() === "sub" ? "sub" : "function", params, body: m[4] };
}

/**
 * Exit Sub / Exit Function as macro steps. Inside a called procedure a StopMacro would end the
 * whole macro, so `If x Then Exit Sub` becomes an If whose other branches hold the rest.
 */
export function liftExits(steps: MacroStep[]): MacroStep[] {
  const isStop = (s: MacroStep | undefined) => s?.kind === "action" && s.action === "StopMacro";
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (isStop(s)) return steps.slice(0, i);
    if (s.kind === "if" && s.branches.some((b) => isStop(b.steps[b.steps.length - 1]))) {
      const rest = liftExits(steps.slice(i + 1));
      const branches = s.branches.map((b) => (isStop(b.steps[b.steps.length - 1]) ? { ...b, steps: liftExits(b.steps.slice(0, -1)) } : { ...b, steps: [...b.steps, ...rest] }));
      if (!branches.some((b) => b.condition === undefined) && rest.length) branches.push({ steps: rest });
      return [...steps.slice(0, i), { kind: "if", branches }];
    }
  }
  return steps;
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
  vbblack: "0",
  vbred: "255",
  vbgreen: "65280",
  vbyellow: "65535",
  vbblue: "16711680",
  vbmagenta: "16711935",
  vbcyan: "16776960",
  vbwhite: "16777215",
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
  /** Const and Enum values from the database's modules (lower-case name, or enum.member). */
  constants?: ReadonlyMap<string, string>;
  /** The form's Access name, for Me.Name. */
  formName?: string;
}

/** Const declarations and Enum members in VBA modules, as expression literals. */
export function vbaConstants(sources: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const lit = (v: string) => {
    const t = v.trim().replace(/\s+As\s+\w+$/i, "");
    if (/^"(?:[^"]|"")*"$/.test(t) || /^-?\d+(\.\d+)?$/.test(t) || /^#[^#]+#$/.test(t) || /^(True|False)$/i.test(t)) return t;
    if (/^&H[0-9A-F]+&?$/i.test(t)) return String(parseInt(t.replace(/^&H|&$/gi, ""), 16));
    return out.get(t.toLowerCase()) ?? null;
  };
  for (const src of sources) {
    const lines = src.replace(/[ \t]_[ \t]*\r?\n/g, " ").split(/\r?\n/).map((l) => l.replace(/^\s*\d+\s+/, "").replace(/'.*$/, "").trim());
    let en: { name: string; next: number } | null = null;
    for (const l of lines) {
      let m: RegExpExecArray | null;
      if ((m = /^(?:(?:Public|Private|Global)\s+)?Enum\s+(\w+)/i.exec(l))) en = { name: m[1].toLowerCase(), next: 0 };
      else if (en && /^End\s+Enum/i.test(l)) en = null;
      else if (en && (m = /^(\w+)(?:\s*=\s*(.+))?$/.exec(l))) {
        const v = m[2] !== undefined ? Number(lit(m[2])) : en.next;
        if (Number.isFinite(v)) {
          out.set(`${en.name}.${m[1].toLowerCase()}`, String(v));
          if (!out.has(m[1].toLowerCase())) out.set(m[1].toLowerCase(), String(v));
          en.next = v + 1;
        }
      } else if ((m = /^(?:(?:Public|Private|Global)\s+)?Const\s+(.+)$/i.exec(l))) {
        for (const part of m[1].split(/,(?=\s*\w+(?:\s+As\s+\w+)?\s*=)/)) {
          const d = /^\s*(\w+)(?:\s+As\s+\w+)?\s*=\s*(.+)$/i.exec(part);
          const v = d && lit(d[2]);
          if (d && v !== null) out.set(d[1].toLowerCase(), v);
        }
      }
    }
  }
  return out;
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
      if (tok.k === "word" && head === "me" && parts.length > 2 && /^form$/i.test(parts[1])) parts.splice(1, 1); // Me.Form.X is Me.X
      if (tok.k === "word" && head === "me" && parts.length === 2 && /^(newrecord|dirty|filteron|filter)$/i.test(parts[1])) {
        // Read from the form while the macro runs.
        out += `[${{ newrecord: "NewRecord", dirty: "Dirty", filteron: "FilterOn", filter: "Filter" }[parts[1].toLowerCase()]}]`;
      } else if (tok.k === "word" && head === "me" && parts.length === 2 && /^name$/i.test(parts[1]) && scope.formName) {
        out += `"${scope.formName.replace(/"/g, '""')}"`;
      } else if (tok.k === "word" && parts.length === 2 && scope.constants?.has(`${head}.${parts[1].toLowerCase()}`)) {
        out += scope.constants.get(`${head}.${parts[1].toLowerCase()}`);
      } else if (tok.k === "word" && head === "me") {
        if (parts.length === 1) throw new VbaError("Me on its own can't be used in an expression.");
        if (parts.length > 2 && !/^(value|text)$/i.test(parts[2])) throw new VbaError(`Me.${parts.slice(1).join(".")} can't be read in a macro.`);
        if (/^(recordsetclone|recordset|openargs|name)$/i.test(parts[1])) throw new VbaError(`Me.${parts[1]} isn't available in macros.`);
        out += q(parts[1]);
      } else if (tok.k === "word" && (head === "forms" || head === "reports") && parts.length >= 2) {
        out += [head === "forms" ? "[Forms]" : "[Reports]", ...parts.slice(1).filter((p, k) => !(k >= 2 && /^(value|text|form)$/i.test(p))).map(q)].join("!");
      } else if (tok.k === "word" && head === "tempvars" && parts.length === 2) {
        out += `[TempVars]![${parts[1]}]`;
      } else if (parts.length === 1 && tok.k === "word") {
        const w = tok.v.toLowerCase();
        if (scope.locals.has(w)) out += `[LocalVars]![${tok.v}]`;
        else if (w in VB_CONSTANTS) out += VB_CONSTANTS[w];
        else if (scope.constants?.has(w) && !(next?.k === "op" && next.v === "(")) out += scope.constants.get(w);
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
  // DoCmd.Close acForm, Me.Name closes this form: the same as Close with no arguments.
  if (m === "close" && /^Me\.Name$/i.test((named.get("objectname") ?? positional[1] ?? "").trim())) return { kind: "action", action: "CloseWindow" };
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
  for (const physical of joined.split(/\r?\n/)) {
    // VBA line numbers (10 On Error GoTo …, used for Erl) aren't part of the statement.
    const raw = physical.replace(/^\s*\d+(?=\s|$)/, "");
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
export interface VbaOptions {
  /** The form's own module (its other procedures can be called). */
  module?: string;
  names?: ReadonlySet<string>;
  constants?: ReadonlyMap<string, string>;
  formName?: string;
  /** Finds a procedure by name in the form's module or the database's standard modules. */
  procedures?: (name: string) => VbaProcedure | null;
  /** The procedure being converted: assigning to its name sets a Function's result (not needed here). */
  procName?: string;
}

/** A call to another procedure: its parameters set from the arguments, then its steps. */
function inlineCall(proc: VbaProcedure, argSrc: string, scope: Scope, opts: VbaOptions, depth: number, unconverted: string[]): MacroStep {
  const { positional, named } = splitArgs(argSrc.trim());
  let body = proc.body;
  const setup: MacroStep[] = [];
  const locals = new Set<string>();
  proc.params.forEach((p, i) => {
    const raw = (named.get(p.name.toLowerCase()) ?? positional[i] ?? "").trim();
    if (/^Me$/i.test(raw)) {
      // A form passed in (frm As Form): frm.X is the form's X.
      body = body.replace(new RegExp(`\\b${p.name}\\b`, "gi"), "Me");
      return;
    }
    const value = raw || p.default || "Null";
    let expr: string;
    try {
      expr = vbaExpr(value, scope);
    } catch (e) {
      unconverted.push(`${proc.name} ${argSrc}`);
      expr = "Null";
    }
    setup.push({ kind: "action", action: "SetLocalVar", args: { Name: p.name, Expression: expr } });
    locals.add(p.name.toLowerCase());
  });
  // Parameters and the procedure's own Dim'd variables are local variables.
  body = proc.params
    .filter((p) => locals.has(p.name.toLowerCase()))
    .map((p) => `Dim ${p.name}`)
    .join("\n") + "\n" + body;
  const inner = vbaToSteps(body, { ...opts, procName: proc.name }, depth + 1);
  unconverted.push(...inner.unconverted);
  return { kind: "group", name: `${proc.name} (from VBA)`, steps: [...setup, ...liftExits(inner.steps)] };
}

/** An event property that calls a function (=OpenOrders([ID])): that function's steps. */
export function vbaEventCall(value: string, opts: VbaOptions): VbaConversion | null {
  const m = /^=\s*(?:\w+\.)?([A-Za-z_]\w*)\s*\(([\s\S]*)\)\s*$/.exec(value.trim());
  const proc = m && (opts.procedures?.(m[1]) ?? (opts.module ? findProcedure(opts.module, m[1]) : null));
  if (!m || !proc) return null;
  const unconverted: string[] = [];
  const scope: Scope = { locals: new Set(), names: opts.names, constants: opts.constants, formName: opts.formName };
  const group = inlineCall(proc, m[2], scope, opts, 0, unconverted) as Extract<MacroStep, { kind: "group" }>;
  return { steps: group.steps, unconverted };
}

export function vbaToSteps(
  body: string,
  opts: VbaOptions = {},
  depth = 0,
): VbaConversion {
  const module = opts.module ?? "";
  const lines = logicalLines(body);
  const unconverted: string[] = [];
  const scope: Scope = { locals: new Set(), names: opts.names, constants: opts.constants, formName: opts.formName };
  // With Me / With Me.ctl: lines inside use .X for Me.X.
  const withs: string[] = [];
  // Select Case: its expression, while its Cases become If / Else If branches.
  const selects: { expr: string; ifIndex: number }[] = [];
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
  const BLOCK = /^(For\b|Do\b|While\b|With\b|Select\s+Case\b)/i;
  const BLOCK_END = /^(End\s+Select|Next\b|Loop\b|Wend\b|End\s+With)/i;

  for (let i = 0; i < lines.length; i++) {
    const original = lines[i];
    const target = withs[withs.length - 1];
    const line = target ? original.replace(/(^|[\s(,=&+\-*\/<>])\.(?=[A-Za-z_\[])/g, `$1${target}.`) : original;
    let m: RegExpExecArray | null;
    try {
      if ((m = /^With\s+(Me(?:[.!](?:\[[^\]]+\]|\w+))?)$/i.exec(line))) {
        withs.push(m[1]);
        continue;
      }
      if (/^End\s+With$/i.test(line) && withs.length) {
        withs.pop();
        continue;
      }
      if ((m = /^Select\s+Case\s+(.+)$/i.exec(line))) {
        const step: Extract<MacroStep, { kind: "if" }> = { kind: "if", branches: [] };
        cur.push(step);
        ifs.push({ step, outer: cur });
        selects.push({ expr: m[1], ifIndex: ifs.length - 1 });
        cur = [];
        continue;
      }
      if ((m = /^Case\s+(.+)$/i.exec(line)) && selects.length && selects[selects.length - 1].ifIndex === ifs.length - 1) {
        const sel = selects[selects.length - 1];
        const top = ifs[ifs.length - 1].step;
        if (/^Else$/i.test(m[1].trim())) top.branches.push({ steps: [] });
        else {
          const e = `(${sel.expr})`;
          const tests = splitArgs(m[1]).positional.map((v) => {
            const to = /^(.+?)\s+To\s+(.+)$/i.exec(v);
            if (to) return `(${e} >= ${to[1]} And ${e} <= ${to[2]})`;
            const is = /^Is\s*(<>|<=|>=|=|<|>)\s*(.+)$/i.exec(v);
            if (is) return `${e} ${is[1]} ${is[2]}`;
            return `${e} = ${v}`;
          });
          top.branches.push({ condition: condition(tests.join(" Or "), line), steps: [] });
        }
        cur = top.branches[top.branches.length - 1].steps;
        continue;
      }
      if (/^End\s+Select$/i.test(line) && selects.length && selects[selects.length - 1].ifIndex === ifs.length - 1) {
        selects.pop();
        const { step, outer } = ifs.pop()!;
        if (!step.branches.length) outer.splice(outer.indexOf(step), 1);
        cur = outer;
        continue;
      }
      // Debugging aids, and theme shading (ForeShade, BackTint…) that only fine-tunes a color: nothing to do here.
      if (/^Debug\.(Print|Assert)\b/i.test(line) || /^(?:Me[.!])?(?:\[[^\]]+\]|\w+)\.(Fore|Back|Border|Hover|Pressed|Gridline)(Shade|Tint|ThemeColorIndex)\s*=/i.test(line)) continue;
      // Object housekeeping (Set x = Nothing, collections, closing recordsets) and requerying, which
      // isn't needed here: forms always show the current data.
      if (
        /^Set\s+\w+\s*=\s*(Nothing|New\s+Collection|New\s+Scripting\.Dictionary)$/i.test(line) ||
        /^g_\w+\.(Add|Remove)\b/i.test(line) ||
        /^\w+\.Close$/i.test(line) && !/^(Me|DoCmd)\./i.test(line) ||
        /^Forms![\w\[\]]+(?:\.Form)?(?:\.Recordset)?\.(Requery|Refresh|Recalc|Repaint)$/i.test(line) ||
        /^Me(?:\.Form)?\.Recordset\.Requery$/i.test(line)
      )
        continue;
      // GoTo a label: in practice the exit / error handler, which ends the procedure.
      if (/^GoTo\s+\w+$/i.test(line)) {
        add(act("StopMacro"));
        continue;
      }
      // db.Execute "UPDATE …", dbFailOnError runs the SQL without asking, like RunSQL after SetWarnings No.
      if ((m = /^(?:CurrentDb(?:\(\))?|DBEngine\(0\)\(0\)|\w+\(\)|\w+)\.Execute\s*\(?([\s\S]+?)\)?$/i.exec(line))) {
        const sql = splitArgs(m[1]).positional[0];
        if (sql) {
          add(act("SetWarnings", { WarningsOn: "No" }));
          add(act("RunSQL", { SQLStatement: textArg(sql, scope) }));
          add(act("SetWarnings", { WarningsOn: "Yes" }));
          continue;
        }
      }
      if ((m = /^RunCommand\s+([\s\S]+)$/i.exec(line))) {
        add(docmdStep("RunCommand", m[1], scope));
        continue;
      }
      // A label: the rest is the wizard's exit / error-handling code (Exit_X: Exit Sub, Err_X: MsgBox Err.Description).
      if (/^[A-Za-z_]\w*:$/.test(line)) break;
      if (/^Exit\s+(Sub|Function)$/i.test(line)) {
        add(act("StopMacro"));
        continue;
      }
      if (/^(Dim|Static|Private|Const)\s/i.test(line)) {
        for (const d of line.replace(/^(Dim|Static|Private|Const)\s+/i, "").split(",")) {
          const n = /^\s*([A-Za-z_]\w*)/.exec(d)?.[1];
          if (n) scope.locals.add(n.toLowerCase());
        }
        if (/^Const\s/i.test(line)) {
          // A procedure's own constants: their values, from here on.
          const own = new Map(scope.constants ?? []);
          for (const [k, v] of vbaConstants([line])) own.set(k, v);
          for (const n of own.keys()) scope.locals.delete(n);
          scope.constants = own;
        }
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
      // Another procedure (of the form's module, or a standard module): its steps, in place.
      if ((m = /^(?:\w+\.)?([A-Za-z_]\w*)(?:\s*\(([\s\S]*)\)|\s+([\s\S]+))?$/.exec(stmt)) && depth < 4 && !/^\s*=/.test(m[3] ?? "") && m[1].toLowerCase() !== opts.procName?.toLowerCase() && !/^(beep|stop|end|exit|resume|return|debug|set|let|dim|redim|me|docmd)$/i.test(m[1])) {
        const proc = opts.procedures?.(m[1]) ?? (module ? findProcedure(module, m[1]) : null);
        if (proc) {
          add(inlineCall(proc, m[2] ?? m[3] ?? "", scope, opts, depth, unconverted));
          continue;
        }
      }
      // Set frm = New Form_Orders … frm.Visible = True: opens the form (Access's second-instance trick).
      if ((m = /^Set\s+\w+\s*=\s*New\s+Form_(\w+)$/i.exec(stmt))) {
        add(act("OpenForm", { FormName: m[1] }));
        continue;
      }
      if (/^\w+\.Visible\s*=\s*True$/i.test(stmt) && !/^Me\./i.test(stmt) && !scope.names?.has(stmt.split(".")[0].toLowerCase())) continue;
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
        // A Function's result: event code doesn't use it.
        if (opts.procName && target.toLowerCase() === opts.procName.toLowerCase()) continue;
        let t: RegExpExecArray | null;
        if ((t = /^TempVars(?:!(\w+)|\("([^"]+)"\)|!\[([^\]]+)\]|\.Item\("([^"]+)"\))$/i.exec(target))) {
          add(act("SetTempVar", { Name: t[1] ?? t[2] ?? t[3] ?? t[4], Expression: vbaExpr(value, scope) }));
          continue;
        }
        if (/^[A-Za-z_]\w*$/.test(target) && scope.locals.has(target.toLowerCase())) {
          add(act("SetLocalVar", { Name: target, Expression: vbaExpr(value, scope) }));
          continue;
        }
        if ((t = /^(?:Me[.!])?(\[[^\]]+\]|\w+)\.(Visible|Enabled|Locked|Caption|ForeColor|BackColor|FontBold|Value)$/i.exec(target)) && !/^me$/i.test(t[1])) {
          const name = t[1].replace(/^\[|\]$/g, "");
          const prop = t[2][0].toUpperCase() + t[2].slice(1).toLowerCase();
          add(act("SetProperty", { ControlName: name, Property: { forecolor: "ForeColor", backcolor: "BackColor", fontbold: "FontBold" }[prop.toLowerCase()] ?? prop, Value: textArg(value, scope) }));
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
