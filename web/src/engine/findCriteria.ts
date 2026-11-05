/**
 * Criteria typed into a form's fields in Find mode (Filter by Form), checked against each record.
 * Access's criteria plus FileMaker's friendlier shorthands:
 *
 *   Smith            Text: contains "Smith" (any case). Numbers, dates, Yes/No: equals.
 *   =Smith           exactly "Smith"           =        is blank
 *   *                has any value             S*  ?at  wildcards (Like "S*" too)
 *   >100  <=5  <>0   comparisons               10...20  1/1/2026...3/31/2026   from … to
 *   Between 1 And 5  In ("A", "B")             Not …    Is Null / Is Not Null
 *   a Or b           either                    "quoted text" for text with spaces or symbols
 *
 * For lookup fields, text criteria also match what's shown (e.g. a customer's name).
 */
import type { CellValue, Field } from "../../../shared/model";
import { parseAccessDate } from "./accessSql";

export type CellTest = (value: CellValue, shown?: string) => boolean;
export type CompiledCriteria = { ok: true; test: CellTest } | { ok: false; error: string };

type Kind = "text" | "number" | "date" | "bool";
const kindOf = (f?: Pick<Field, "type">): Kind =>
  f?.type === "Number" || f?.type === "AutoNumber" || f?.type === "Currency"
    ? "number"
    : f?.type === "DateTime"
      ? "date"
      : f?.type === "YesNo"
        ? "bool"
        : "text";

const blank = (v: CellValue) => v === null || v === undefined || v === "";
const unquote = (s: string) => {
  const t = s.trim();
  return /^".*"$/.test(t) || /^'.*'$/.test(t) ? t.slice(1, -1).replace(/""/g, '"') : t;
};

/** A typed value as the field's kind; null when it can't be. */
function literal(raw: string, kind: Kind): number | string | boolean | null {
  const s = unquote(raw.trim().replace(/^#(.*)#$/, "$1"));
  if (kind === "number") {
    const n = Number(s.replace(/[$,\s]/g, ""));
    return s !== "" && Number.isFinite(n) ? n : null;
  }
  if (kind === "date") return parseAccessDate(s);
  if (kind === "bool") return /^(yes|true|-1|on|y)$/i.test(s) ? true : /^(no|false|0|off|n)$/i.test(s) ? false : null;
  return s;
}

/** Compares a stored value with a literal of the same kind: <0, 0, >0. */
function compare(v: CellValue, lit: number | string | boolean, kind: Kind): number {
  if (kind === "number") return Number(v) - (lit as number);
  if (kind === "bool") return Number(v === true || v === 1) - Number(lit === true);
  if (kind === "date") {
    // A date without a time matches the whole day.
    const a = String(v);
    const b = String(lit);
    return b.length === 10 ? a.slice(0, 10).localeCompare(b) : a.localeCompare(b);
  }
  return String(v).localeCompare(String(lit), undefined, { sensitivity: "base", numeric: true });
}

function wildcard(pattern: string): RegExp {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".").replace(/#/g, "\\d");
  return new RegExp(`^${re}$`, "is");
}

/** Splits at a top-level word (Or / And), outside quotes and brackets. */
function splitWord(s: string, word: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  const re = new RegExp(`^\\s${word}\\s`, "i");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "#") {
      if (c !== "#" || /\d/.test(s[i + 1] ?? "")) quote = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && re.test(s.slice(i))) {
      parts.push(s.slice(start, i));
      start = i + word.length + 2;
      i = start - 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function compileCriteria(input: string, field?: Pick<Field, "type" | "name">, opts: { lookup?: boolean } = {}): CompiledCriteria {
  const kind = kindOf(field);
  const name = field?.name ?? "this field";
  const bad = (why: string): CompiledCriteria => ({ ok: false, error: `${name}: ${why}` });
  const text = input.trim();
  if (!text) return { ok: true, test: () => true };

  // a Or b
  const ors = splitWord(text, "or");
  if (ors.length > 1) {
    const tests: CellTest[] = [];
    for (const o of ors) {
      const c = compileCriteria(o, field, opts);
      if (!c.ok) return c;
      tests.push(c.test);
    }
    return { ok: true, test: (v, shown) => tests.some((t) => t(v, shown)) };
  }

  let m: RegExpExecArray | null;
  if ((m = /^not\s+(.+)$/i.exec(text)) && !/^not\s+(like|in|between)\b/i.test(text)) {
    const inner = compileCriteria(m[1], field, opts);
    return inner.ok ? { ok: true, test: (v, s) => !blank(v) && !inner.test(v, s) } : inner;
  }
  if (/^is\s+null$/i.test(text) || text === "=") return { ok: true, test: (v) => blank(v) };
  if (/^is\s+not\s+null$/i.test(text) || text === "*" || text === "<>") return { ok: true, test: (v) => !blank(v) };

  const lit = (s: string) => {
    const l = literal(s, kind);
    return l === null ? null : l;
  };
  const mustLit = (s: string): number | string | boolean => {
    const l = lit(s);
    if (l === null) throw new Error(kind === "date" ? `'${s.trim()}' isn't a date. Use 12/31/2026 or 2026-12-31.` : kind === "number" ? `'${s.trim()}' isn't a number.` : `'${s.trim()}' isn't Yes or No.`);
    return l;
  };

  try {
    // Ranges: 1...10, Between 1 And 10
    if ((m = /^(.*?)\.\.\.(.*)$/.exec(text)) || (m = /^between\s+(.+?)\s+and\s+(.+)$/i.exec(text))) {
      const lo = m[1].trim() ? mustLit(m[1]) : null;
      const hi = m[2].trim() ? mustLit(m[2]) : null;
      return {
        ok: true,
        test: (v) => !blank(v) && (lo === null || compare(v, lo, kind) >= 0) && (hi === null || compare(v, hi, kind) <= 0),
      };
    }
    // In (a, b, c)
    if ((m = /^(not\s+)?in\s*\((.*)\)$/i.exec(text))) {
      const neg = !!m[1];
      const items = m[2].split(",").map((s) => mustLit(s));
      return { ok: true, test: (v, shown) => !blank(v) && items.some((i) => compare(v, i, kind) === 0 || (shown !== undefined && compare(shown, i, "text") === 0)) !== neg };
    }
    // Like "pattern" (and Not Like)
    if ((m = /^(not\s+)?(?:a?like)\s+(.+)$/i.exec(text))) {
      const neg = !!m[1];
      const re = wildcard(unquote(m[2]));
      return { ok: true, test: (v, shown) => !blank(v) && (re.test(String(v)) || (shown !== undefined && re.test(shown))) !== neg };
    }
    // Comparisons
    if ((m = /^(<=|>=|<>|!=|=|<|>)\s*(.*)$/.exec(text))) {
      const op = m[1] === "!=" ? "<>" : m[1];
      const rhs = m[2];
      if (!rhs.trim()) return op === "=" ? { ok: true, test: (v) => blank(v) } : bad(`'${text}' needs a value after ${op}.`);
      // =Text matches the shown value too (lookups); for text, = is exact (any case).
      if (opts.lookup && (op === "=" || op === "<>") && lit(rhs) === null) {
        const want = String(unquote(rhs));
        return { ok: true, test: (v, shown) => !blank(v) && shown !== undefined && (compare(shown, want, "text") === 0) === (op === "=") };
      }
      const l = mustLit(rhs);
      const cmp = (v: CellValue, shown?: string) => {
        if (op === "=" || op === "<>") {
          const eq = compare(v, l, kind) === 0 || (shown !== undefined && compare(shown, String(unquote(rhs)), "text") === 0);
          return op === "=" ? eq : !eq;
        }
        const d = compare(v, l, kind);
        return op === "<" ? d < 0 : op === ">" ? d > 0 : op === "<=" ? d <= 0 : d >= 0;
      };
      return { ok: true, test: (v, shown) => !blank(v) && cmp(v, shown) };
    }
    // Wildcards typed plainly: S*, *son, ?at
    if ((kind === "text" || opts.lookup) && /[*?]/.test(text)) {
      const re = wildcard(unquote(text));
      return { ok: true, test: (v, shown) => !blank(v) && (re.test(String(v)) || (shown !== undefined && re.test(shown))) };
    }
    // A plain value: text contains it (any case); other kinds equal it.
    if (kind === "text") {
      const needle = unquote(text).toLowerCase();
      return { ok: true, test: (v, shown) => !blank(v) && (String(v).toLowerCase().includes(needle) || (shown !== undefined && shown.toLowerCase().includes(needle))) };
    }
    const l = lit(text);
    if (l === null && !opts.lookup) return bad(kind === "date" ? `'${text}' isn't a date. Use 12/31/2026 or 2026-12-31.` : kind === "number" ? `'${text}' isn't a number.` : `'${text}' isn't Yes or No.`);
    if (l === null) {
      // A lookup's number field searched by its shown name.
      const needle = unquote(text).toLowerCase();
      return { ok: true, test: (v, shown) => shown !== undefined && !blank(v) && shown.toLowerCase().includes(needle) };
    }
    return { ok: true, test: (v) => !blank(v) && compare(v, l, kind) === 0 };
  } catch (e) {
    return bad((e as Error).message);
  }
}
