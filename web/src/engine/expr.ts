/**
 * Access expressions, as typed in a calculated control's Control Source:
 *
 *   =[FirstName] & " " & [LastName]
 *   =IIf([Balance] > 0, "Owes " & Format([Balance], "Currency"), "Paid up")
 *   =DateDiff("yyyy", [BirthDate], Date())
 *   =Sum([Quantity] * [UnitPrice])              (over the form's records, in a header or footer)
 *   =DCount("*", "Orders", "CustomerID=" & [CustomerID])
 *
 * Parsed once into a tree, then evaluated against the current record. Dates are ISO text
 * ("2026-11-12" or "2026-11-12T14:04:00"), like everywhere else in the app.
 */
import { formatDate } from "./values";
import { parseAccessDate } from "./accessSql";

export type ExprValue = number | string | boolean | null;

export interface ExprContext {
  /** A field or control's value by name, or undefined when there's no such name. */
  lookup(name: string): ExprValue | undefined;
  /** The form's records (for Sum, Count, Avg…). */
  records?(): ExprContext[];
  /** A table's rows by name (for DLookup, DCount…), or undefined when there's no such table. */
  domain?(name: string): ExprContext[] | undefined;
}

/** Why an expression can't be worked out; `display` is what the control shows (#Name? or #Error). */
export class ExprError extends Error {
  constructor(
    message: string,
    readonly display: "#Name?" | "#Error" | "#Div/0!" = "#Error",
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- tokens

type Tok =
  | { k: "num"; v: number; at: number }
  | { k: "str"; v: string; at: number }
  | { k: "date"; v: string; at: number }
  | { k: "ref"; v: string; at: number }
  | { k: "word"; v: string; at: number }
  | { k: "op"; v: string; at: number }
  | { k: "end"; at: number };

export class ExprSyntaxError extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
  }
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const at = i;
    if (c === "«") {
      const end = src.indexOf("»", i);
      const what = src.slice(i + 1, end < 0 ? undefined : end);
      throw new ExprSyntaxError(`Replace «${what}» with a value, a field or an expression.`, at);
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ k: "num", v: Number(m[0]), at });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let s = "";
      i++;
      for (;;) {
        if (i >= src.length) throw new ExprSyntaxError("This text is missing its closing quote.", at);
        if (src[i] === c) {
          if (src[i + 1] === c) {
            s += c;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++];
      }
      out.push({ k: "str", v: s, at });
      continue;
    }
    if (c === "#") {
      const end = src.indexOf("#", i + 1);
      if (end < 0) throw new ExprSyntaxError("This date is missing its closing #.", at);
      const d = parseAccessDate(src.slice(i + 1, end).trim());
      if (!d) throw new ExprSyntaxError(`#${src.slice(i + 1, end)}# isn't a date. Use #12/31/2026# or #2026-12-31#.`, at);
      out.push({ k: "date", v: d, at });
      i = end + 1;
      continue;
    }
    if (c === "[") {
      const end = src.indexOf("]", i);
      if (end < 0) throw new ExprSyntaxError("This name is missing its closing ].", at);
      out.push({ k: "ref", v: src.slice(i + 1, end), at });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ k: "word", v: m[0], at });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") {
      out.push({ k: "op", v: two, at });
      i += 2;
      continue;
    }
    if ("=<>+-*/\\^&(),.!".includes(c)) {
      out.push({ k: "op", v: c, at });
      i++;
      continue;
    }
    throw new ExprSyntaxError(`'${c}' can't be used here.`, at);
  }
  out.push({ k: "end", at: src.length });
  return out;
}

// ---------------------------------------------------------------- tree

export type Node =
  | { k: "lit"; v: ExprValue }
  | { k: "ref"; name: string }
  | { k: "star" }
  | { k: "call"; name: string; args: Node[] }
  | { k: "bin"; op: string; l: Node; r: Node }
  | { k: "neg"; e: Node }
  | { k: "not"; e: Node }
  | { k: "isnull"; e: Node; neg: boolean }
  | { k: "like"; e: Node; pat: Node; neg: boolean }
  | { k: "between"; e: Node; lo: Node; hi: Node; neg: boolean }
  | { k: "in"; e: Node; items: Node[]; neg: boolean };

const KEYWORDS = new Set(["and", "or", "xor", "not", "mod", "like", "is", "between", "in"]);

class Parser {
  i = 0;
  constructor(readonly t: Tok[]) {}
  peek(): Tok {
    return this.t[this.i];
  }
  next(): Tok {
    return this.t[this.i++];
  }
  isOp(v: string) {
    const p = this.peek();
    return p.k === "op" && p.v === v;
  }
  isWord(v: string) {
    const p = this.peek();
    return p.k === "word" && p.v.toLowerCase() === v;
  }
  expect(v: string, what: string) {
    if (!this.isOp(v)) throw new ExprSyntaxError(what, this.peek().at);
    this.i++;
  }

  // Lowest to highest: Or/Xor, And, Not, comparisons, &, + -, Mod, \, * /, unary -, ^.
  or(): Node {
    let l = this.and();
    while (this.isWord("or") || this.isWord("xor")) {
      const op = (this.next() as { v: string }).v.toLowerCase();
      l = { k: "bin", op, l, r: this.and() };
    }
    return l;
  }
  and(): Node {
    let l = this.not();
    while (this.isWord("and")) {
      this.i++;
      l = { k: "bin", op: "and", l, r: this.not() };
    }
    return l;
  }
  not(): Node {
    if (this.isWord("not")) {
      this.i++;
      return { k: "not", e: this.not() };
    }
    return this.compare();
  }
  compare(): Node {
    let l = this.concat();
    for (;;) {
      const p = this.peek();
      if (p.k === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(p.v)) {
        this.i++;
        l = { k: "bin", op: p.v, l, r: this.concat() };
        continue;
      }
      let neg = false;
      if (this.isWord("not") && this.t[this.i + 1]?.k === "word" && ["like", "between", "in"].includes((this.t[this.i + 1] as { v: string }).v.toLowerCase())) {
        this.i++;
        neg = true;
      }
      if (this.isWord("like")) {
        this.i++;
        l = { k: "like", e: l, pat: this.concat(), neg };
        continue;
      }
      if (this.isWord("between")) {
        this.i++;
        const lo = this.concat();
        if (!this.isWord("and")) throw new ExprSyntaxError("Between needs And: Between 1 And 10.", this.peek().at);
        this.i++;
        l = { k: "between", e: l, lo, hi: this.concat(), neg };
        continue;
      }
      if (this.isWord("in")) {
        this.i++;
        this.expect("(", "In needs a list in brackets: In (1, 2, 3).");
        const items = [this.or()];
        while (this.isOp(",")) {
          this.i++;
          items.push(this.or());
        }
        this.expect(")", "The In list is missing its closing ).");
        l = { k: "in", e: l, items, neg };
        continue;
      }
      if (this.isWord("is")) {
        this.i++;
        const isNot = this.isWord("not");
        if (isNot) this.i++;
        if (!this.isWord("null")) throw new ExprSyntaxError("Use Is Null or Is Not Null.", this.peek().at);
        this.i++;
        l = { k: "isnull", e: l, neg: isNot };
        continue;
      }
      return l;
    }
  }
  concat(): Node {
    let l = this.add();
    while (this.isOp("&")) {
      this.i++;
      l = { k: "bin", op: "&", l, r: this.add() };
    }
    return l;
  }
  add(): Node {
    let l = this.mod();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.next() as { v: string }).v;
      l = { k: "bin", op, l, r: this.mod() };
    }
    return l;
  }
  mod(): Node {
    let l = this.intDiv();
    while (this.isWord("mod")) {
      this.i++;
      l = { k: "bin", op: "mod", l, r: this.intDiv() };
    }
    return l;
  }
  intDiv(): Node {
    let l = this.mul();
    while (this.isOp("\\")) {
      this.i++;
      l = { k: "bin", op: "\\", l, r: this.mul() };
    }
    return l;
  }
  mul(): Node {
    let l = this.unary();
    while (this.isOp("*") || this.isOp("/")) {
      const op = (this.next() as { v: string }).v;
      l = { k: "bin", op, l, r: this.unary() };
    }
    return l;
  }
  unary(): Node {
    if (this.isOp("-")) {
      this.i++;
      return { k: "neg", e: this.unary() };
    }
    if (this.isOp("+")) {
      this.i++;
      return this.unary();
    }
    return this.pow();
  }
  pow(): Node {
    const l = this.primary();
    if (this.isOp("^")) {
      this.i++;
      return { k: "bin", op: "^", l, r: this.unary() };
    }
    return l;
  }
  primary(): Node {
    const t = this.next();
    switch (t.k) {
      case "num":
      case "str":
      case "date":
        return { k: "lit", v: t.v };
      case "ref":
        return this.qualified(t.v);
      case "op":
        if (t.v === "(") {
          const e = this.or();
          this.expect(")", "A bracket ( is missing its closing ).");
          return e;
        }
        if (t.v === "*") return { k: "star" };
        throw new ExprSyntaxError(t.v === ")" ? "There's an extra )." : `Something is missing before '${t.v}'.`, t.at);
      case "word": {
        const w = t.v.toLowerCase();
        if (w === "true" || w === "yes" || w === "on") return { k: "lit", v: true };
        if (w === "false" || w === "no" || w === "off") return { k: "lit", v: false };
        if (w === "null") return { k: "lit", v: null };
        if (this.isOp("(")) {
          const fn = FUNCTIONS[w];
          if (!fn) throw new ExprSyntaxError(`There's no function called ${t.v}.`, t.at);
          this.i++;
          const args: Node[] = [];
          if (!this.isOp(")")) {
            args.push(this.or());
            while (this.isOp(",")) {
              this.i++;
              args.push(this.or());
            }
          }
          this.expect(")", `${fn.name}( is missing its closing ).`);
          if (args.length < fn.min || args.length > fn.max) {
            throw new ExprSyntaxError(`${fn.name} takes ${fn.min === fn.max ? fn.min : `${fn.min} to ${fn.max}`} value${fn.max === 1 ? "" : "s"}: ${fn.syntax}`, t.at);
          }
          if (args.some((a) => a.k === "star") && !["count", "dcount"].includes(w)) throw new ExprSyntaxError("* can only be used in Count(*).", t.at);
          return { k: "call", name: w, args };
        }
        if (KEYWORDS.has(w)) throw new ExprSyntaxError(`Something is missing before ${t.v}.`, t.at);
        return this.qualified(t.v);
      }
      case "end":
        throw new ExprSyntaxError("The expression ends too soon. Something is missing at the end.", t.at);
    }
  }
  /** [Orders].[CustomerID] or [Forms]![Customers]![Name]: the last part is the name. */
  qualified(first: string): Node {
    let name = first;
    while ((this.isOp(".") || this.isOp("!")) && (this.t[this.i + 1]?.k === "ref" || this.t[this.i + 1]?.k === "word")) {
      this.i++;
      name = (this.next() as { v: string }).v;
    }
    return { k: "ref", name };
  }
}

export type Compiled = { ok: true; node: Node } | { ok: false; error: string; at: number };
const cache = new Map<string, Compiled>();

/** Parses an expression (with or without its leading =). */
export function compileExpression(text: string): Compiled {
  const src = text.replace(/^\s*=/, "");
  const hit = cache.get(src);
  if (hit) return hit;
  let r: Compiled;
  try {
    if (!src.trim()) throw new ExprSyntaxError("The expression is empty.", 0);
    const p = new Parser(tokenize(src));
    const node = p.or();
    if (p.peek().k !== "end") {
      const t = p.peek();
      throw new ExprSyntaxError(
        t.k === "op" && t.v === ")" ? "There's an extra )." : "There's something extra here. Join pieces of text with &, and numbers with + - * /.",
        t.at,
      );
    }
    r = { ok: true, node };
  } catch (e) {
    if (!(e instanceof ExprSyntaxError)) throw e;
    r = { ok: false, error: e.message, at: e.at };
  }
  if (cache.size > 500) cache.clear();
  cache.set(src, r);
  return r;
}

/** The field and control names an expression uses (for checking them before saving). */
export function namesUsed(node: Node): string[] {
  const out: string[] = [];
  const walk = (n: Node) => {
    switch (n.k) {
      case "ref":
        out.push(n.name);
        return;
      case "call":
        n.args.forEach(walk);
        return;
      case "bin":
        walk(n.l);
        walk(n.r);
        return;
      case "neg":
      case "not":
      case "isnull":
        walk(n.e);
        return;
      case "like":
        walk(n.e);
        walk(n.pat);
        return;
      case "between":
        walk(n.e);
        walk(n.lo);
        walk(n.hi);
        return;
      case "in":
        walk(n.e);
        n.items.forEach(walk);
        return;
    }
  };
  walk(node);
  return [...new Set(out)];
}

// ---------------------------------------------------------------- values

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/;
/** ISO date text (a subtype of string, so a false check doesn't rule out other text). */
type DateText = string & { readonly __isoDate?: true };
const isDate = (v: ExprValue): v is DateText => typeof v === "string" && ISO.test(v);
const DAY = 86_400_000;

/** ISO date text → days since 1970 (fractional for the time of day). */
function serial(v: string): number {
  const m = ISO.exec(v)!;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) / DAY;
}
function fromSerial(n: number, withTime: boolean): string {
  const d = new Date(Math.round(n * DAY / 1000) * 1000);
  const iso = d.toISOString();
  return withTime && iso.slice(11, 19) !== "00:00:00" ? iso.slice(0, 19) : iso.slice(0, 10);
}
function parts(v: string) {
  const m = ISO.exec(v)!;
  return { y: +m[1], m: +m[2], d: +m[3], h: +(m[4] ?? 0), n: +(m[5] ?? 0), s: +(m[6] ?? 0), time: !!m[4] };
}
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const isoOf = (y: number, m: number, d: number, h = 0, n = 0, s = 0, time = false) => {
  const dt = new Date(Date.UTC(y, m - 1, d, h, n, s));
  return fromSerial(dt.getTime() / DAY, time);
};

function localNow(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}

function num(v: ExprValue, what = "a number"): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? -1 : 0;
  if (isDate(v)) return serial(v);
  if (typeof v === "string") {
    const t = v.trim().replace(/[$,]/g, "");
    if (t !== "" && Number.isFinite(Number(t))) return Number(t);
  }
  throw new ExprError(`'${v}' isn't ${what}.`);
}
function date(v: ExprValue): string {
  if (isDate(v)) return v;
  if (typeof v === "string") {
    const d = parseAccessDate(v.trim());
    if (d) return d;
  }
  if (typeof v === "number") return fromSerial(v, true);
  throw new ExprError(`'${v}' isn't a date.`);
}

/** How a value reads when joined into text with &. */
export function text(v: ExprValue): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return numberText(v);
  if (isDate(v)) return formatDate(v);
  return v;
}
function numberText(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(15)));
}
const truthy = (v: ExprValue) => v !== null && v !== "" && v !== false && v !== 0 && v !== "0";

function compareValues(a: ExprValue, b: ExprValue): number {
  if (isDate(a) && isDate(b)) return serial(a) - serial(b);
  if (typeof a === "number" || typeof b === "number" || typeof a === "boolean" || typeof b === "boolean") {
    if (isDate(a) || isDate(b)) return num(a) - num(b);
    return num(a, "a number to compare") - num(b, "a number to compare");
  }
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
}

function likeRe(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "#") re += "\\d";
    else if (c === "[") {
      const end = pattern.indexOf("]", i);
      if (end < 0) re += "\\[";
      else {
        re += "[" + pattern.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]";
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "is");
}

/** Access's Round: halves go to the even number. */
function bankersRound(n: number, places = 0): number {
  const f = 10 ** places;
  const x = n * f;
  const r = Math.round(x);
  const diff = Math.abs(x % 1);
  const even = Math.abs(diff - 0.5) < 1e-9 ? (r % 2 === 0 ? r : r - 1) : r;
  return even / f;
}

// ---------------------------------------------------------------- Format()

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekday = (iso: string) => new Date(serial(iso) * DAY).getUTCDay();

export const NAMED_FORMATS = [
  "General Number",
  "Currency",
  "Euro",
  "Fixed",
  "Standard",
  "Percent",
  "Scientific",
  "General Date",
  "Long Date",
  "Medium Date",
  "Short Date",
  "Long Time",
  "Medium Time",
  "Short Time",
  "Yes/No",
  "True/False",
  "On/Off",
] as const;

function numberPattern(n: number, pattern: string): string {
  // Sections: positive;negative;zero;null
  const sections = pattern.split(";");
  let p = sections[0];
  let v = n;
  if (n < 0 && sections[1]) {
    p = sections[1];
    v = -n;
  } else if (n === 0 && sections[2]) p = sections[2];
  const pct = p.includes("%");
  if (pct) v *= 100;
  const m = /[0#][0#,]*(\.[0#]+)?/.exec(p);
  if (!m) return p.replace(/\\(.)/g, "$1").replace(/"([^"]*)"/g, "$1");
  const decimals = m[1] ? m[1].length - 1 : 0;
  const minDecimals = m[1] ? (m[1].match(/0/g) ?? []).length : 0;
  const intPart = m[0].split(".")[0];
  const minInt = (intPart.match(/0/g) ?? []).length;
  const body = new Intl.NumberFormat("en-US", {
    useGrouping: intPart.includes(","),
    minimumFractionDigits: minDecimals,
    maximumFractionDigits: decimals,
    minimumIntegerDigits: Math.max(1, minInt),
  }).format(Math.abs(v));
  const shown = minInt === 0 && body.startsWith("0.") ? body.slice(1) : minInt === 0 && body === "0" ? "" : body;
  const lit = (s: string) => s.replace(/"([^"]*)"/g, "$1").replace(/\\(.)/g, "$1");
  return (v < 0 ? "-" : "") + lit(p.slice(0, m.index)) + shown + lit(p.slice(m.index + m[0].length));
}

function datePattern(iso: string, pattern: string): string {
  const p = parts(iso);
  const out: string[] = [];
  const re = /"[^"]*"|\\.|yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|nn|n|ss|s|AM\/PM|am\/pm|A\/P|a\/p|q|ww|w|y|./g;
  let afterHour = false;
  for (const tok of pattern.match(re) ?? []) {
    const t = tok.toLowerCase();
    if (tok.startsWith('"')) out.push(tok.slice(1, -1));
    else if (tok.startsWith("\\")) out.push(tok.slice(1));
    else if (t === "yyyy") out.push(String(p.y));
    else if (t === "yy") out.push(pad(p.y % 100));
    else if (t === "mmmm") out.push(MONTHS[p.m - 1]);
    else if (t === "mmm") out.push(MONTHS[p.m - 1].slice(0, 3));
    else if (t === "mm") out.push(afterHour ? pad(p.n) : pad(p.m));
    else if (t === "m") out.push(afterHour ? String(p.n) : String(p.m));
    else if (t === "dddd") out.push(DAYS[weekday(iso)]);
    else if (t === "ddd") out.push(DAYS[weekday(iso)].slice(0, 3));
    else if (t === "dd") out.push(pad(p.d));
    else if (t === "d") out.push(String(p.d));
    else if (t === "hh" || t === "h") {
      const twelve = /am\/pm|a\/p/i.test(pattern);
      const h = twelve ? p.h % 12 || 12 : p.h;
      out.push(t === "hh" ? pad(h) : String(h));
    } else if (t === "nn") out.push(pad(p.n));
    else if (t === "n") out.push(String(p.n));
    else if (t === "ss") out.push(pad(p.s));
    else if (t === "s") out.push(String(p.s));
    else if (t === "am/pm") out.push(p.h < 12 ? (tok === "AM/PM" ? "AM" : "am") : tok === "AM/PM" ? "PM" : "pm");
    else if (t === "a/p") out.push(p.h < 12 ? (tok === "A/P" ? "A" : "a") : tok === "A/P" ? "P" : "p");
    else if (t === "q") out.push(String(Math.ceil(p.m / 3)));
    else if (t === "y") out.push(String(Math.round(serial(iso) - serial(`${p.y}-01-01`)) + 1));
    else if (t === "ww") out.push(String(Math.floor((serial(iso.slice(0, 10)) - serial(`${p.y}-01-01`) + new Date(Date.UTC(p.y, 0, 1)).getUTCDay()) / 7) + 1));
    else if (t === "w") out.push(String(weekday(iso) + 1));
    else out.push(tok);
    afterHour = t === "hh" || t === "h" || (afterHour && !/[a-z]/i.test(tok));
  }
  return out.join("");
}

/** Access's Format(value, format), for the named formats and the usual 0 # yyyy mm dd patterns. */
export function formatExpr(v: ExprValue, fmt: string): string {
  if (v === null) return "";
  const f = fmt.trim();
  const lf = f.toLowerCase();
  const n = () => num(v);
  switch (lf) {
    case "":
    case "general number":
      return text(v);
    case "currency":
      return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", currencySign: "accounting" }).format(n());
    case "euro":
      return new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" }).format(n());
    case "fixed":
      return n().toFixed(2);
    case "standard":
      return numberPattern(n(), "#,##0.00");
    case "percent":
      return numberPattern(n(), "0.00%");
    case "scientific":
      return n().toExponential(2).toUpperCase();
    case "yes/no":
      return truthy(v) ? "Yes" : "No";
    case "true/false":
      return truthy(v) ? "True" : "False";
    case "on/off":
      return truthy(v) ? "On" : "Off";
    case "general date":
      return formatDate(date(v));
    case "long date":
      return datePattern(date(v), "dddd, mmmm d, yyyy");
    case "medium date":
      return datePattern(date(v), "dd-mmm-yy");
    case "short date":
      return datePattern(date(v), "m/d/yyyy");
    case "long time":
      return datePattern(date(v), "h:nn:ss AM/PM");
    case "medium time":
      return datePattern(date(v), "hh:nn AM/PM");
    case "short time":
      return datePattern(date(v), "hh:nn");
  }
  if (f === ">") return text(v).toUpperCase();
  if (f === "<") return text(v).toLowerCase();
  if (isDate(v) || (typeof v === "string" && parseAccessDate(v) && /[ydmhn]/i.test(f) && !/[0#]/.test(f))) return datePattern(date(v), f);
  if (/[0#]/.test(f)) return numberPattern(n(), f);
  if (/[@&]/.test(f)) {
    // Text placeholders: each @ takes one character.
    const s = text(v);
    let k = 0;
    const out = f.replace(/[@&]/g, () => s[k++] ?? (f.includes("&") ? "" : " "));
    return out + s.slice(k);
  }
  return text(v);
}

// ---------------------------------------------------------------- functions

type Fn = {
  name: string;
  cat: FnCategory;
  syntax: string;
  desc: string;
  min: number;
  max: number;
  /** Called with evaluated arguments (absent when the function evaluates its own). */
  run?: (a: ExprValue[]) => ExprValue;
};
export type FnCategory = "Text" | "Date/Time" | "Math" | "Conversion" | "Program Flow" | "Inspection" | "SQL Aggregate" | "Domain Aggregate";

const str = (v: ExprValue) => (v === null ? null : text(v));
const nullOr = <T,>(v: ExprValue, f: (v: Exclude<ExprValue, null>) => T): T | null => (v === null ? null : f(v));

function dateAdd(interval: string, n: number, d: string): string {
  const p = parts(d);
  const i = interval.toLowerCase();
  const k = Math.trunc(n);
  switch (i) {
    case "yyyy":
      return clampDay(p.y + k, p.m, p.d, p);
    case "q":
      return addMonths(p, k * 3);
    case "m":
      return addMonths(p, k);
    case "ww":
      return fromSerial(serial(d) + k * 7, p.time);
    case "d":
    case "y":
    case "w":
      return fromSerial(serial(d) + k, p.time);
    case "h":
      return fromSerial(serial(d) + n / 24, true);
    case "n":
      return fromSerial(serial(d) + n / 1440, true);
    case "s":
      return fromSerial(serial(d) + n / 86400, true);
  }
  throw new ExprError(`'${interval}' isn't an interval. Use "yyyy", "q", "m", "ww", "d", "h", "n" or "s".`);
}
function addMonths(p: ReturnType<typeof parts>, k: number) {
  const total = p.y * 12 + (p.m - 1) + k;
  return clampDay(Math.floor(total / 12), (total % 12) + 1, p.d, p);
}
function clampDay(y: number, m: number, d: number, p: ReturnType<typeof parts>) {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return isoOf(y, m, Math.min(d, last), p.h, p.n, p.s, p.time);
}
function dateDiff(interval: string, a: string, b: string): number {
  const p = parts(a);
  const q = parts(b);
  switch (interval.toLowerCase()) {
    case "yyyy":
      return q.y - p.y;
    case "q":
      return (q.y - p.y) * 4 + (Math.ceil(q.m / 3) - Math.ceil(p.m / 3));
    case "m":
      return (q.y - p.y) * 12 + (q.m - p.m);
    case "d":
    case "y":
      return Math.round(serial(b.slice(0, 10)) - serial(a.slice(0, 10)));
    case "w":
      return Math.trunc((serial(b.slice(0, 10)) - serial(a.slice(0, 10))) / 7);
    case "ww": {
      // Sundays crossed, like Access.
      const s1 = Math.floor((serial(a.slice(0, 10)) + 4) / 7);
      const s2 = Math.floor((serial(b.slice(0, 10)) + 4) / 7);
      return s2 - s1;
    }
    case "h":
      return Math.floor(serial(b) * 24 + 1e-9) - Math.floor(serial(a) * 24 + 1e-9);
    case "n":
      return Math.round((serial(b) - serial(a)) * 1440);
    case "s":
      return Math.round((serial(b) - serial(a)) * 86400);
  }
  throw new ExprError(`'${interval}' isn't an interval. Use "yyyy", "q", "m", "ww", "d", "h", "n" or "s".`);
}

const FN_LIST: Fn[] = [
  // Text
  { name: "Left", cat: "Text", syntax: "Left(«string», «length»)", desc: "The first characters of a piece of text.", min: 2, max: 2, run: ([s, n]) => nullOr(s, (s) => text(s).slice(0, Math.max(0, num(n)))) },
  { name: "Right", cat: "Text", syntax: "Right(«string», «length»)", desc: "The last characters of a piece of text.", min: 2, max: 2, run: ([s, n]) => nullOr(s, (s) => (num(n) <= 0 ? "" : text(s).slice(-num(n)))) },
  { name: "Mid", cat: "Text", syntax: "Mid(«string», «start», «length»)", desc: "Characters from the middle of text, starting at «start» (1 is the first). Leave out «length» for the rest.", min: 2, max: 3, run: ([s, st, n]) => nullOr(s, (s) => text(s).substr(Math.max(0, num(st) - 1), n === undefined || n === null ? undefined : num(n))) },
  { name: "Len", cat: "Text", syntax: "Len(«string»)", desc: "How many characters the text has.", min: 1, max: 1, run: ([s]) => nullOr(s, (s) => text(s).length) },
  { name: "Trim", cat: "Text", syntax: "Trim(«string»)", desc: "The text without spaces at the start and end.", min: 1, max: 1, run: ([s]) => nullOr(s, (s) => text(s).trim()) },
  { name: "LTrim", cat: "Text", syntax: "LTrim(«string»)", desc: "The text without spaces at the start.", min: 1, max: 1, run: ([s]) => nullOr(s, (s) => text(s).trimStart()) },
  { name: "RTrim", cat: "Text", syntax: "RTrim(«string»)", desc: "The text without spaces at the end.", min: 1, max: 1, run: ([s]) => nullOr(s, (s) => text(s).trimEnd()) },
  { name: "UCase", cat: "Text", syntax: "UCase(«string»)", desc: "The text in CAPITAL letters.", min: 1, max: 1, run: ([s]) => nullOr(s, (s) => text(s).toUpperCase()) },
  { name: "LCase", cat: "Text", syntax: "LCase(«string»)", desc: "The text in small letters.", min: 1, max: 1, run: ([s]) => nullOr(s, (s) => text(s).toLowerCase()) },
  {
    name: "StrConv", cat: "Text", syntax: "StrConv(«string», «conversion»)", desc: "Changes the case: 1 = UPPER, 2 = lower, 3 = Proper Case (each word capitalized).", min: 2, max: 2,
    run: ([s, c]) => nullOr(s, (s) => {
      const t = text(s);
      const k = num(c);
      return k === 1 ? t.toUpperCase() : k === 2 ? t.toLowerCase() : k === 3 ? t.toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase()) : t;
    }),
  },
  {
    name: "InStr", cat: "Text", syntax: "InStr(«start», «string1», «string2»)", desc: "Where «string2» first appears in «string1» (1 is the first character; 0 if it doesn't). «start» is optional.", min: 2, max: 3,
    run: (a) => {
      const [st, s1, s2] = a.length === 3 ? a : [1, a[0], a[1]];
      if (s1 === null || s2 === null) return null;
      return text(s1).toLowerCase().indexOf(text(s2).toLowerCase(), num(st) - 1) + 1;
    },
  },
  { name: "Replace", cat: "Text", syntax: "Replace(«string», «find», «replace»)", desc: "The text with every «find» changed to «replace».", min: 3, max: 3, run: ([s, f, r]) => nullOr(s, (s) => (text(f ?? "") === "" ? text(s) : text(s).split(text(f ?? "")).join(text(r ?? "")))) },
  { name: "Space", cat: "Text", syntax: "Space(«number»)", desc: "That many spaces.", min: 1, max: 1, run: ([n]) => " ".repeat(Math.max(0, Math.min(10000, num(n)))) },
  { name: "String", cat: "Text", syntax: "String(«number», «character»)", desc: "A character repeated that many times.", min: 2, max: 2, run: ([n, c]) => text(c).charAt(0).repeat(Math.max(0, Math.min(10000, num(n)))) },
  { name: "StrReverse", cat: "Text", syntax: "StrReverse(«string»)", desc: "The text backwards.", min: 1, max: 1, run: ([s]) => nullOr(s, (s) => [...text(s)].reverse().join("")) },
  { name: "Format", cat: "Text", syntax: "Format(«expr», «format»)", desc: 'A value shown a certain way: "Currency", "Percent", "Short Date", "Long Date", "0.00", "mm/dd/yyyy", "mmmm d, yyyy", "hh:nn AM/PM"…', min: 1, max: 2, run: ([v, f]) => formatExpr(v, f === undefined || f === null ? "" : text(f)) },
  // Date/Time
  { name: "Date", cat: "Date/Time", syntax: "Date()", desc: "Today's date.", min: 0, max: 0, run: () => localNow().slice(0, 10) },
  { name: "Now", cat: "Date/Time", syntax: "Now()", desc: "Today's date and the time now.", min: 0, max: 0, run: () => localNow() },
  { name: "Time", cat: "Date/Time", syntax: "Time()", desc: "The time now.", min: 0, max: 0, run: () => datePattern(localNow(), "h:nn:ss AM/PM") },
  { name: "Year", cat: "Date/Time", syntax: "Year(«date»)", desc: "The year of a date.", min: 1, max: 1, run: ([d]) => nullOr(d, (d) => parts(date(d)).y) },
  { name: "Month", cat: "Date/Time", syntax: "Month(«date»)", desc: "The month of a date, 1 to 12.", min: 1, max: 1, run: ([d]) => nullOr(d, (d) => parts(date(d)).m) },
  { name: "Day", cat: "Date/Time", syntax: "Day(«date»)", desc: "The day of the month, 1 to 31.", min: 1, max: 1, run: ([d]) => nullOr(d, (d) => parts(date(d)).d) },
  { name: "Hour", cat: "Date/Time", syntax: "Hour(«time»)", desc: "The hour, 0 to 23.", min: 1, max: 1, run: ([d]) => nullOr(d, (d) => parts(date(d)).h) },
  { name: "Minute", cat: "Date/Time", syntax: "Minute(«time»)", desc: "The minute, 0 to 59.", min: 1, max: 1, run: ([d]) => nullOr(d, (d) => parts(date(d)).n) },
  { name: "Second", cat: "Date/Time", syntax: "Second(«time»)", desc: "The second, 0 to 59.", min: 1, max: 1, run: ([d]) => nullOr(d, (d) => parts(date(d)).s) },
  { name: "Weekday", cat: "Date/Time", syntax: "Weekday(«date»)", desc: "The day of the week: 1 = Sunday … 7 = Saturday.", min: 1, max: 1, run: ([d]) => nullOr(d, (d) => weekday(date(d)) + 1) },
  { name: "WeekdayName", cat: "Date/Time", syntax: "WeekdayName(«weekday», «abbreviate»)", desc: "The name of a weekday number (1 = Sunday). «abbreviate» True gives Sun, Mon…", min: 1, max: 2, run: ([n, ab]) => nullOr(n, (n) => { const s = DAYS[(num(n) - 1 + 70) % 7]; return ab && truthy(ab) ? s.slice(0, 3) : s; }) },
  { name: "MonthName", cat: "Date/Time", syntax: "MonthName(«month», «abbreviate»)", desc: "The name of a month number (1 = January). «abbreviate» True gives Jan, Feb…", min: 1, max: 2, run: ([n, ab]) => nullOr(n, (n) => { const s = MONTHS[(num(n) - 1 + 120) % 12]; return ab && truthy(ab) ? s.slice(0, 3) : s; }) },
  { name: "DateAdd", cat: "Date/Time", syntax: "DateAdd(«interval», «number», «date»)", desc: 'A date moved by a number of intervals: "yyyy" years, "q" quarters, "m" months, "ww" weeks, "d" days, "h" hours, "n" minutes, "s" seconds.', min: 3, max: 3, run: ([i, n, d]) => (d === null || n === null ? null : dateAdd(text(i), num(n), date(d))) },
  { name: "DateDiff", cat: "Date/Time", syntax: "DateDiff(«interval», «date1», «date2»)", desc: 'How many intervals from «date1» to «date2»: "yyyy" years, "m" months, "ww" weeks, "d" days, "h" hours, "n" minutes.', min: 2, max: 3, run: ([i, a, b]) => (a === null || (b ?? null) === null ? null : dateDiff(text(i), date(a), date(b!))) },
  {
    name: "DatePart", cat: "Date/Time", syntax: "DatePart(«interval», «date»)", desc: 'One part of a date: "yyyy" year, "q" quarter, "m" month, "d" day, "w" weekday, "ww" week of the year, "h" hour, "n" minute.', min: 2, max: 2,
    run: ([i, d]) => {
      if (d === null) return null;
      const iso = date(d);
      const k = text(i).toLowerCase();
      const map: Record<string, string> = { yyyy: "yyyy", q: "q", m: "m", d: "d", w: "w", ww: "ww", h: "h", n: "n", s: "s", y: "y" };
      if (!map[k]) throw new ExprError(`'${text(i)}' isn't an interval.`);
      return Number(datePattern(iso, k === "h" ? "H" : map[k]).replace(/\D/g, "")) || 0;
    },
  },
  { name: "DateSerial", cat: "Date/Time", syntax: "DateSerial(«year», «month», «day»)", desc: "The date for a year, month and day (months and days past the end roll over).", min: 3, max: 3, run: ([y, m, d]) => isoOf(num(y), num(m), num(d)) },
  { name: "DateValue", cat: "Date/Time", syntax: "DateValue(«string»)", desc: "The date written in a piece of text.", min: 1, max: 1, run: ([s]) => nullOr(s, (s) => date(s).slice(0, 10)) },
  // Math
  { name: "Abs", cat: "Math", syntax: "Abs(«number»)", desc: "The number without its minus sign.", min: 1, max: 1, run: ([n]) => nullOr(n, (n) => Math.abs(num(n))) },
  { name: "Int", cat: "Math", syntax: "Int(«number»)", desc: "The whole number at or below (Int(-2.5) is -3).", min: 1, max: 1, run: ([n]) => nullOr(n, (n) => Math.floor(num(n))) },
  { name: "Fix", cat: "Math", syntax: "Fix(«number»)", desc: "The whole-number part (Fix(-2.5) is -2).", min: 1, max: 1, run: ([n]) => nullOr(n, (n) => Math.trunc(num(n))) },
  { name: "Round", cat: "Math", syntax: "Round(«number», «decimals»)", desc: "The number rounded to that many decimal places (halves go to the even number, like Access).", min: 1, max: 2, run: ([n, d]) => nullOr(n, (n) => bankersRound(num(n), d === undefined || d === null ? 0 : num(d))) },
  { name: "Sqr", cat: "Math", syntax: "Sqr(«number»)", desc: "The square root.", min: 1, max: 1, run: ([n]) => nullOr(n, (n) => { const x = num(n); if (x < 0) throw new ExprError("Sqr can't take a negative number."); return Math.sqrt(x); }) },
  { name: "Sgn", cat: "Math", syntax: "Sgn(«number»)", desc: "1 if positive, -1 if negative, 0 if zero.", min: 1, max: 1, run: ([n]) => nullOr(n, (n) => Math.sign(num(n))) },
  { name: "Exp", cat: "Math", syntax: "Exp(«number»)", desc: "e raised to the number.", min: 1, max: 1, run: ([n]) => nullOr(n, (n) => Math.exp(num(n))) },
  { name: "Log", cat: "Math", syntax: "Log(«number»)", desc: "The natural logarithm.", min: 1, max: 1, run: ([n]) => nullOr(n, (n) => Math.log(num(n))) },
  // Conversion
  { name: "Nz", cat: "Conversion", syntax: "Nz(«value», «valueifnull»)", desc: "The value, or «valueifnull» (or 0 / empty) when it's blank.", min: 1, max: 2, run: ([v, d]) => (v === null ? (d === undefined ? 0 : d) : v) },
  { name: "CStr", cat: "Conversion", syntax: "CStr(«expr»)", desc: "The value as text.", min: 1, max: 1, run: ([v]) => str(v) },
  { name: "CInt", cat: "Conversion", syntax: "CInt(«expr»)", desc: "The value as a whole number (rounded).", min: 1, max: 1, run: ([v]) => nullOr(v, (v) => bankersRound(num(v))) },
  { name: "CLng", cat: "Conversion", syntax: "CLng(«expr»)", desc: "The value as a whole number (rounded).", min: 1, max: 1, run: ([v]) => nullOr(v, (v) => bankersRound(num(v))) },
  { name: "CDbl", cat: "Conversion", syntax: "CDbl(«expr»)", desc: "The value as a number.", min: 1, max: 1, run: ([v]) => nullOr(v, (v) => num(v)) },
  { name: "CCur", cat: "Conversion", syntax: "CCur(«expr»)", desc: "The value as money (4 decimal places).", min: 1, max: 1, run: ([v]) => nullOr(v, (v) => Math.round(num(v) * 10000) / 10000) },
  { name: "CBool", cat: "Conversion", syntax: "CBool(«expr»)", desc: "The value as True or False.", min: 1, max: 1, run: ([v]) => nullOr(v, (v) => truthy(v)) },
  { name: "CDate", cat: "Conversion", syntax: "CDate(«expr»)", desc: "The value as a date.", min: 1, max: 1, run: ([v]) => nullOr(v, (v) => date(v)) },
  { name: "Val", cat: "Conversion", syntax: "Val(«string»)", desc: "The number at the start of a piece of text (Val(\"12 Main St\") is 12).", min: 1, max: 1, run: ([v]) => { const m = /^\s*[-+]?\d*\.?\d+/.exec(text(v)); return m ? Number(m[0]) : 0; } },
  { name: "Str", cat: "Conversion", syntax: "Str(«number»)", desc: "A number as text.", min: 1, max: 1, run: ([v]) => nullOr(v, (v) => (num(v) >= 0 ? " " : "") + numberText(num(v))) },
  // Program flow
  { name: "IIf", cat: "Program Flow", syntax: "IIf(«expr», «truepart», «falsepart»)", desc: "«truepart» when «expr» is true, otherwise «falsepart».", min: 3, max: 3 },
  { name: "Switch", cat: "Program Flow", syntax: "Switch(«expr1», «value1», «expr2», «value2»)", desc: "The value after the first expression that's true (Null if none is).", min: 2, max: 40 },
  { name: "Choose", cat: "Program Flow", syntax: "Choose(«index», «choice1», «choice2»)", desc: "The choice in that position (1 is the first).", min: 2, max: 40 },
  // Inspection
  { name: "IsNull", cat: "Inspection", syntax: "IsNull(«expr»)", desc: "True when the value is blank.", min: 1, max: 1, run: ([v]) => v === null },
  { name: "IsNumeric", cat: "Inspection", syntax: "IsNumeric(«expr»)", desc: "True when the value is a number.", min: 1, max: 1, run: ([v]) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.replace(/[$,]/g, "")))) },
  { name: "IsDate", cat: "Inspection", syntax: "IsDate(«expr»)", desc: "True when the value is (or reads as) a date.", min: 1, max: 1, run: ([v]) => isDate(v) || (typeof v === "string" && !!parseAccessDate(v.trim())) },
  // SQL aggregates (over the form's records)
  { name: "Sum", cat: "SQL Aggregate", syntax: "Sum(«expr»)", desc: "The total over all the form's records. Use it in the form header or footer.", min: 1, max: 1 },
  { name: "Avg", cat: "SQL Aggregate", syntax: "Avg(«expr»)", desc: "The average over the form's records.", min: 1, max: 1 },
  { name: "Count", cat: "SQL Aggregate", syntax: "Count(«expr»)", desc: "How many of the form's records have a value; Count(*) counts every record.", min: 1, max: 1 },
  { name: "Min", cat: "SQL Aggregate", syntax: "Min(«expr»)", desc: "The smallest value in the form's records.", min: 1, max: 1 },
  { name: "Max", cat: "SQL Aggregate", syntax: "Max(«expr»)", desc: "The largest value in the form's records.", min: 1, max: 1 },
  // Domain aggregates (any table)
  { name: "DLookup", cat: "Domain Aggregate", syntax: 'DLookup("«expr»", "«domain»", "«criteria»")', desc: 'A value from another table: DLookup("CompanyName", "Customers", "CustomerID=" & [CustomerID]).', min: 2, max: 3 },
  { name: "DCount", cat: "Domain Aggregate", syntax: 'DCount("«expr»", "«domain»", "«criteria»")', desc: 'How many records in a table match: DCount("*", "Orders", "CustomerID=" & [CustomerID]).', min: 2, max: 3 },
  { name: "DSum", cat: "Domain Aggregate", syntax: 'DSum("«expr»", "«domain»", "«criteria»")', desc: "The total of a field in a table's matching records.", min: 2, max: 3 },
  { name: "DAvg", cat: "Domain Aggregate", syntax: 'DAvg("«expr»", "«domain»", "«criteria»")', desc: "The average of a field in a table's matching records.", min: 2, max: 3 },
  { name: "DMin", cat: "Domain Aggregate", syntax: 'DMin("«expr»", "«domain»", "«criteria»")', desc: "The smallest value in a table's matching records.", min: 2, max: 3 },
  { name: "DMax", cat: "Domain Aggregate", syntax: 'DMax("«expr»", "«domain»", "«criteria»")', desc: "The largest value in a table's matching records.", min: 2, max: 3 },
  { name: "DFirst", cat: "Domain Aggregate", syntax: 'DFirst("«expr»", "«domain»", "«criteria»")', desc: "The value in the first matching record.", min: 2, max: 3 },
  { name: "DLast", cat: "Domain Aggregate", syntax: 'DLast("«expr»", "«domain»", "«criteria»")', desc: "The value in the last matching record.", min: 2, max: 3 },
];

export const FUNCTIONS: Record<string, Fn> = Object.fromEntries(FN_LIST.map((f) => [f.name.toLowerCase(), f]));
export const FUNCTION_LIST: readonly Fn[] = FN_LIST;
const DOMAIN = new Set(["dlookup", "dcount", "dsum", "davg", "dmin", "dmax", "dfirst", "dlast"]);
const AGG = new Set(["sum", "avg", "count", "min", "max"]);

// ---------------------------------------------------------------- evaluation

function aggregate(name: string, values: ExprValue[], countAll = false): ExprValue {
  if (name === "count") return countAll ? values.length : values.filter((v) => v !== null).length;
  const present = values.filter((v) => v !== null);
  if (name === "min" || name === "max" || name === "first" || name === "last") {
    if (!present.length) return null;
    if (name === "first") return present[0];
    if (name === "last") return present[present.length - 1];
    return present.reduce((a, b) => ((compareValues(a, b) < 0) === (name === "min") ? a : b));
  }
  const nums = present.map((v) => num(v));
  if (!nums.length) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return name === "sum" ? Number(sum.toPrecision(15)) : Number((sum / nums.length).toPrecision(15));
}

export function evaluate(node: Node, ctx: ExprContext, depth = 0): ExprValue {
  if (depth > 40) throw new ExprError("The expression refers to itself.");
  const ev = (n: Node) => evaluate(n, ctx, depth + 1);
  switch (node.k) {
    case "lit":
      return node.v;
    case "star":
      throw new ExprError("* can only be used in Count(*).");
    case "ref": {
      const v = ctx.lookup(node.name);
      if (v === undefined) throw new ExprError(`There's no field or control named [${node.name}].`, "#Name?");
      return v;
    }
    case "neg": {
      const v = ev(node.e);
      return v === null ? null : -num(v);
    }
    case "not": {
      const v = ev(node.e);
      return v === null ? null : !truthy(v);
    }
    case "isnull": {
      const v = ev(node.e);
      return (v === null) !== node.neg;
    }
    case "like": {
      const v = ev(node.e);
      const p = ev(node.pat);
      if (v === null || p === null) return null;
      return likeRe(text(p)).test(text(v)) !== node.neg;
    }
    case "between": {
      const v = ev(node.e);
      const lo = ev(node.lo);
      const hi = ev(node.hi);
      if (v === null || lo === null || hi === null) return null;
      return (compareValues(v, lo) >= 0 && compareValues(v, hi) <= 0) !== node.neg;
    }
    case "in": {
      const v = ev(node.e);
      if (v === null) return null;
      return node.items.some((i) => {
        const x = ev(i);
        return x !== null && compareValues(v, x) === 0;
      }) !== node.neg;
    }
    case "bin":
      return binary(node, ev);
    case "call":
      return call(node, ctx, depth);
  }
}

function binary(node: Extract<Node, { k: "bin" }>, ev: (n: Node) => ExprValue): ExprValue {
  const { op } = node;
  if (op === "and" || op === "or" || op === "xor") {
    const l = ev(node.l);
    const r = ev(node.r);
    if (op === "and") return l === false || r === false ? false : l === null || r === null ? null : truthy(l) && truthy(r);
    if (op === "or") return (l !== null && truthy(l)) || (r !== null && truthy(r)) ? true : l === null || r === null ? null : false;
    return l === null || r === null ? null : truthy(l) !== truthy(r);
  }
  const l = ev(node.l);
  const r = ev(node.r);
  if (op === "&") return text(l) + text(r);
  if (l === null || r === null) return null;
  switch (op) {
    case "=":
      return compareValues(l, r) === 0;
    case "<>":
      return compareValues(l, r) !== 0;
    case "<":
      return compareValues(l, r) < 0;
    case ">":
      return compareValues(l, r) > 0;
    case "<=":
      return compareValues(l, r) <= 0;
    case ">=":
      return compareValues(l, r) >= 0;
    case "+": {
      if (isDate(l) && !isDate(r)) return fromSerial(serial(l) + num(r), l.length > 10 || !Number.isInteger(num(r)));
      if (isDate(r) && !isDate(l)) return fromSerial(serial(r) + num(l), r.length > 10 || !Number.isInteger(num(l)));
      // Two pieces of text join; otherwise add.
      if (typeof l === "string" && typeof r === "string" && !(isNumText(l) && isNumText(r))) return l + r;
      return round15(num(l) + num(r));
    }
    case "-":
      if (isDate(l) && isDate(r)) return round15(serial(l) - serial(r));
      if (isDate(l)) return fromSerial(serial(l) - num(r), l.length > 10 || !Number.isInteger(num(r)));
      return round15(num(l) - num(r));
    case "*":
      return round15(num(l) * num(r));
    case "/": {
      const d = num(r);
      if (d === 0) throw new ExprError("Division by zero.", "#Div/0!");
      return round15(num(l) / d);
    }
    case "\\": {
      const d = Math.round(num(r));
      if (d === 0) throw new ExprError("Division by zero.", "#Div/0!");
      return Math.trunc(Math.round(num(l)) / d);
    }
    case "mod": {
      const d = Math.round(num(r));
      if (d === 0) throw new ExprError("Division by zero.", "#Div/0!");
      return Math.round(num(l)) % d;
    }
    case "^":
      return round15(num(l) ** num(r));
  }
  throw new ExprError(`Unknown operator ${op}.`);
}
const isNumText = (s: string) => s.trim() !== "" && Number.isFinite(Number(s));
const round15 = (n: number) => (Number.isFinite(n) ? Number(n.toPrecision(15)) : n);

function call(node: Extract<Node, { k: "call" }>, ctx: ExprContext, depth: number): ExprValue {
  const ev = (n: Node, c: ExprContext = ctx) => evaluate(n, c, depth + 1);
  const { name, args } = node;
  if (name === "iif") {
    const c = ev(args[0]);
    return ev(c !== null && truthy(c) ? args[1] : args[2]);
  }
  if (name === "switch") {
    for (let i = 0; i + 1 < args.length; i += 2) {
      const c = ev(args[i]);
      if (c !== null && truthy(c)) return ev(args[i + 1]);
    }
    return null;
  }
  if (name === "choose") {
    const i = ev(args[0]);
    if (i === null) return null;
    const k = Math.trunc(num(i));
    return k >= 1 && k < args.length ? ev(args[k]) : null;
  }
  if (AGG.has(name)) {
    const records = ctx.records?.();
    if (!records) throw new ExprError(`${FUNCTIONS[name].name} works over a form's records; use it in the form.`);
    const all = args[0].k === "star";
    return aggregate(name, all ? records.map(() => 1) : records.map((r) => ev(args[0], r)), all);
  }
  if (DOMAIN.has(name)) return domainCall(name, args.map((a) => (a.k === "star" ? "*" : ev(a))), ctx);
  const fn = FUNCTIONS[name];
  return fn.run!(args.map((a) => ev(a)));
}

function domainCall(name: string, a: ExprValue[], ctx: ExprContext): ExprValue {
  const fname = FUNCTIONS[name].name;
  const exprText = text(a[0]);
  const domainName = text(a[1]).replace(/^\[|\]$/g, "");
  const rows = ctx.domain?.(domainName);
  if (!rows) throw new ExprError(`${fname}: there's no table named '${domainName}'.`, "#Name?");
  const crit = a[2] === undefined || a[2] === null || text(a[2]).trim() === "" ? null : compileExpression(text(a[2]));
  if (crit && !crit.ok) throw new ExprError(`${fname}: the criteria "${text(a[2])}" has a problem: ${crit.error}`);
  const matching = crit ? rows.filter((r) => {
    const v = evaluate((crit as { node: Node }).node, r);
    return v !== null && truthy(v);
  }) : rows;
  if (exprText.trim() === "*") {
    if (name !== "dcount") throw new ExprError(`${fname} needs a field name, not *.`);
    return matching.length;
  }
  const e = compileExpression(exprText);
  if (!e.ok) throw new ExprError(`${fname}: "${exprText}" has a problem: ${e.error}`);
  const values = matching.map((r) => evaluate(e.node, r));
  if (name === "dlookup") return values[0] ?? null;
  return aggregate(name.slice(1), values);
}

// ---------------------------------------------------------------- for controls

/** What a calculated control shows: its value as text (with the control's Format), or the error. */
export function displayValue(v: ExprValue, format?: string): string {
  if (format?.trim()) return formatExpr(v, format);
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return text(v);
}

/** A record's row as an expression context: its fields by name, any case. */
export function rowContext(columns: string[], row: readonly unknown[] | null, extra?: Partial<ExprContext> & { lookup?: (name: string) => ExprValue | undefined }): ExprContext {
  const index = new Map(columns.map((c, i) => [c.toLowerCase(), i]));
  return {
    lookup: (name) => {
      const i = index.get(name.toLowerCase());
      if (i !== undefined) return toExpr(row ? row[i] : null);
      return extra?.lookup?.(name);
    },
    records: extra?.records,
    domain: extra?.domain,
  };
}

export function toExpr(v: unknown): ExprValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  return String(v);
}

/** Whether a Control Source is an expression (=…) rather than a field name. */
export const isExpression = (source: string | undefined): boolean => !!source && source.trimStart().startsWith("=");
