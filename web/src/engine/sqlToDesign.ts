/**
 * Reads the SQL of a select query back into the Design View grid, so a query typed or imported
 * as SQL can be worked on visually, like Access does.
 *
 * Handles SELECT [DISTINCT] … FROM tables and queries joined with INNER/LEFT/RIGHT JOIN (on equal
 * fields), WHERE (AND/OR → Criteria and or: rows), GROUP BY, HAVING and ORDER BY, with field
 * references, expressions, aliases (Alias: Field) and totals. Anything else (subqueries, UNION,
 * TOP, DISTINCTROW, PARAMETERS, the same table twice) is reported as not supported yet, with the
 * reason, and the query stays in SQL View.
 */
import type { ProjectDoc, QueryColumn, TotalOption } from "../../../shared/model";
import { tokenize, type Token } from "./accessSql";
import type { QueryDesign } from "./queryDesign";

export type SqlToDesignResult = { ok: true; design: QueryDesign } | { ok: false; reason: string };

export interface SqlToDesignOptions {
  /** Field (output column) names of linked tables and saved queries used as sources, by lower-case name. */
  sourceFields?: Map<string, string[]>;
  /**
   * The column names the original SQL produces when run. Used to keep the names of unnamed
   * expressions and totals (which Access would otherwise rename, e.g. Sum([Amount]) → SumOfAmount).
   */
  outputNames?: string[];
}

class Unsupported extends Error {}
const fail = (reason: string): never => {
  throw new Unsupported(reason);
};

type Tok = Token & { end: number; up: string };

const AGGREGATES: Record<string, TotalOption> = {
  SUM: "Sum",
  AVG: "Avg",
  MIN: "Min",
  MAX: "Max",
  COUNT: "Count",
  STDEV: "StDev",
  VAR: "Var",
  FIRST: "First",
  LAST: "Last",
};
const CLAUSES = ["FROM", "WHERE", "GROUP", "HAVING", "ORDER"];
const KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "ORDER", "AS", "ON", "AND", "OR", "NOT", "JOIN", "INNER", "LEFT", "RIGHT",
  "OUTER", "FULL", "CROSS", "UNION", "ASC", "DESC", "LIKE", "IN", "IS", "NULL", "BETWEEN", "DISTINCT", "DISTINCTROW", "TOP", "INTO",
]);

/** Adds where each token ends (tokenize only records where it starts). */
function tokens(sql: string): Tok[] {
  const out: Tok[] = [];
  for (const t of tokenize(sql)) {
    let end = t.start + t.text.length;
    if (t.kind === "date") end = t.start + t.text.length + 2;
    if (t.kind === "str") {
      const q = sql[t.start];
      let j = t.start + 1;
      while (j < sql.length) {
        if (sql[j] === q) {
          if (sql[j + 1] === q) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      end = j + 1;
    }
    if (t.kind !== "ws") out.push({ ...t, end, up: t.kind === "word" ? t.text.toUpperCase() : t.text });
  }
  return out;
}

/** A slice of the token list: [a, b). */
interface Range {
  a: number;
  b: number;
}

const nameOf = (t: Tok) => (t.kind === "ident" ? t.text.slice(1, -1) : t.text);
const isName = (t?: Tok) => !!t && (t.kind === "ident" || (t.kind === "word" && !KEYWORDS.has(t.up)));

export function sqlToDesign(doc: ProjectDoc, sql: string, opts: SqlToDesignOptions = {}): SqlToDesignResult {
  try {
    return { ok: true, design: new Parser(doc, sql, opts).parse() };
  } catch (e) {
    if (e instanceof Unsupported) return { ok: false, reason: e.message };
    return { ok: false, reason: `The SQL couldn't be read: ${(e as Error).message}` };
  }
}

interface Ref {
  table: string;
  field: string;
}
type RefResult = Ref | "star" | { starOf: string } | null;

class Parser {
  private t: Tok[];
  /** Sources in FROM order, by their real names. */
  private tables: string[] = [];
  /** Lower-case alias or name → real table or query name. */
  private names = new Map<string, string>();
  private joins: NonNullable<QueryDesign["joins"]> = [];
  private columns: QueryColumn[] = [];
  private totals = false;

  constructor(
    private doc: ProjectDoc,
    private sql: string,
    private opts: SqlToDesignOptions,
  ) {
    this.t = tokens(sql);
  }

  // ---- Helpers over token ranges ----------------------------------------------------------

  private text(r: Range): string {
    if (r.b <= r.a) return "";
    // Rewrite alias.field to [Table].[field], since Design View works with real table names.
    let out = "";
    let pos = this.t[r.a].start;
    for (let i = r.a; i < r.b; i++) {
      const tok = this.t[i];
      if (isName(tok) && this.t[i + 1]?.text === "." && i + 2 < r.b && !(i > r.a && this.t[i - 1].text === ".")) {
        const real = this.names.get(nameOf(tok).toLowerCase());
        if (real && real !== nameOf(tok)) {
          out += this.sql.slice(pos, tok.start) + `[${real}]`;
          pos = tok.end;
        }
      }
    }
    return (out + this.sql.slice(pos, this.t[r.b - 1].end)).trim();
  }

  /** Splits a range at depth-0 tokens that `isSep` accepts (BETWEEN … AND … isn't split). */
  private split(r: Range, isSep: (t: Tok) => boolean): Range[] {
    const parts: Range[] = [];
    let depth = 0;
    let start = r.a;
    let between = false;
    for (let i = r.a; i < r.b; i++) {
      const tok = this.t[i];
      if (tok.text === "(") depth++;
      else if (tok.text === ")") depth--;
      else if (depth === 0) {
        if (tok.up === "BETWEEN") between = true;
        else if (tok.up === "AND" && between) between = false;
        else if (isSep(tok)) {
          parts.push({ a: start, b: i });
          start = i + 1;
        }
      }
    }
    parts.push({ a: start, b: r.b });
    return parts.filter((p) => p.b > p.a);
  }

  /** Index of the ")" matching the "(" at i. */
  private close(i: number, b: number): number {
    let depth = 0;
    for (let j = i; j < b; j++) {
      if (this.t[j].text === "(") depth++;
      else if (this.t[j].text === ")" && --depth === 0) return j;
    }
    return fail("A bracket ( is missing its closing ).");
  }

  /** Removes brackets around the whole range: ((a = 1)) → a = 1. */
  private unwrap(r: Range): Range {
    while (r.b - r.a >= 2 && this.t[r.a].text === "(" && this.close(r.a, r.b) === r.b - 1) r = { a: r.a + 1, b: r.b - 1 };
    return r;
  }

  private hasAggregate(r: Range): boolean {
    for (let i = r.a; i < r.b - 1; i++) if (AGGREGATES[this.t[i].up] && this.t[i + 1].text === "(") return true;
    return false;
  }

  // ---- Sources ---------------------------------------------------------------------------

  private realSource(name: string): string {
    const n = name.toLowerCase();
    const found =
      this.doc.tables.find((t) => t.name.toLowerCase() === n)?.name ??
      this.doc.linkedTables?.find((t) => t.name.toLowerCase() === n)?.name ??
      this.doc.queries.find((q) => q.name.toLowerCase() === n)?.name;
    return found ?? fail(`Access Web can't find the table or query '${name}'.`);
  }

  private fieldsOf(table: string): string[] | undefined {
    const local = this.doc.tables.find((t) => t.name === table);
    if (local) return local.fields.map((f) => f.name);
    return this.opts.sourceFields?.get(table.toLowerCase());
  }

  /** Resolves a field reference written as [T].[F], T.F, [F] or F. Returns null for a name no source has. */
  private resolve(qualifier: string | null, field: string): Ref | null {
    if (qualifier) {
      const table = this.names.get(qualifier.toLowerCase());
      if (!table) return fail(`'${qualifier}' in ${qualifier}.${field} isn't a table or query in FROM.`);
      const fields = this.fieldsOf(table);
      const real = fields?.find((f) => f.toLowerCase() === field.toLowerCase());
      if (fields && !real) return fail(`'${table}' has no field '${field}'.`);
      return { table, field: real ?? field };
    }
    const hits = this.tables.flatMap((t) => {
      const real = this.fieldsOf(t)?.find((f) => f.toLowerCase() === field.toLowerCase());
      return real ? [{ table: t, field: real }] : [];
    });
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return fail(`[${field}] is in more than one table (${hits.map((h) => h.table).join(", ")}). Write it as [Table].[${field}].`);
    if (this.tables.length === 1 && !this.fieldsOf(this.tables[0])) return { table: this.tables[0], field };
    if (this.tables.some((t) => !this.fieldsOf(t))) return fail(`Write [${field}] with its table name, as [Table].[${field}].`);
    return null;
  }

  /** The range as a field reference, if that's all it is. */
  private refOf(r: Range): RefResult {
    r = this.unwrap(r);
    const n = r.b - r.a;
    const [x, y, z] = [this.t[r.a], this.t[r.a + 1], this.t[r.a + 2]];
    if (n === 1 && x.text === "*") return "star";
    if (n === 1 && isName(x)) return this.resolve(null, nameOf(x));
    if (n === 3 && isName(x) && y.text === "." && z.text === "*") {
      const table = this.names.get(nameOf(x).toLowerCase());
      return table ? { starOf: table } : fail(`'${nameOf(x)}.*': '${nameOf(x)}' isn't in FROM.`);
    }
    if (n === 3 && isName(x) && y.text === "." && isName(z)) return this.resolve(nameOf(x), nameOf(z));
    return null;
  }

  // ---- FROM ------------------------------------------------------------------------------

  private parseFrom(r: Range) {
    for (const part of this.split(r, (t) => t.text === ",")) {
      const end = this.parseChain(part.a, part.b);
      if (end !== part.b) fail(`Design View can't show this FROM clause yet: '${this.text(part)}'.`);
    }
  }

  /** source { [INNER|LEFT|RIGHT] [OUTER] JOIN source ON condition }. Returns where it stopped. */
  private parseChain(i: number, b: number): number {
    i = this.parseSource(i, b).end;
    while (i < b) {
      let kind: "inner" | "left" | "right" | null = null;
      const w = this.t[i].up;
      if (w === "JOIN") kind = "inner";
      else if (w === "INNER" && this.t[i + 1]?.up === "JOIN") (kind = "inner"), i++;
      else if ((w === "LEFT" || w === "RIGHT") && (this.t[i + 1]?.up === "JOIN" || (this.t[i + 1]?.up === "OUTER" && this.t[i + 2]?.up === "JOIN"))) {
        kind = w === "LEFT" ? "left" : "right";
        i += this.t[i + 1].up === "OUTER" ? 2 : 1;
      } else if (w === "FULL" || w === "CROSS") fail(`${w} JOIN isn't supported in Access or Design View.`);
      if (!kind) break;
      i++; // JOIN
      const right = this.parseSource(i, b);
      i = right.end;
      if (this.t[i]?.up !== "ON") fail("Every JOIN needs an ON condition that matches fields, like ON [A].[ID] = [B].[ID].");
      i++;
      // The condition runs to the next JOIN keyword or the end of this bracket level.
      let j = i;
      let depth = 0;
      while (j < b) {
        const tk = this.t[j];
        if (tk.text === "(") depth++;
        else if (tk.text === ")") {
          if (depth === 0) break;
          depth--;
        } else if (depth === 0 && ["JOIN", "INNER", "LEFT", "RIGHT"].includes(tk.up)) break;
        j++;
      }
      for (const cond of this.split({ a: i, b: j }, (t) => t.up === "AND")) {
        const sides = this.split(this.unwrap(cond), (t) => t.text === "=");
        const refs = sides.map((s) => this.refOf(s));
        const [p, q] = refs;
        if (sides.length !== 2 || !p || !q || p === "star" || q === "star" || "starOf" in p || "starOf" in q) {
          fail(`Design View can only show joins that match two fields with =. This one is '${this.text(cond)}'.`);
        }
        const [r1, r2] = [p as Ref, q as Ref];
        let joinKind: "inner" | "left" | "right" = "inner";
        if (kind !== "inner") {
          // LEFT JOIN keeps every record of the left-hand side; RIGHT JOIN of the right-hand side.
          const r1Right = right.tables.includes(r1.table);
          const keepR1 = kind === "left" ? !r1Right : r1Right;
          joinKind = keepR1 ? "left" : "right";
        }
        this.joins.push({ t1: r1.table, f1: r1.field, t2: r2.table, f2: r2.field, kind: joinKind });
      }
      i = j;
    }
    return i;
  }

  /** A table/query name with an optional alias, or a bracketed join. */
  private parseSource(i: number, b: number): { end: number; tables: string[] } {
    const tok = this.t[i];
    if (!tok) return fail("FROM is missing a table name.");
    if (tok.text === "(") {
      if (this.t[i + 1]?.up === "SELECT") fail("Design View can't show subqueries yet.");
      const close = this.close(i, b);
      const before = this.tables.length;
      const end = this.parseChain(i + 1, close);
      if (end !== close) fail(`Design View can't show this part of FROM yet: '${this.text({ a: i, b: close + 1 })}'.`);
      return { end: close + 1, tables: this.tables.slice(before) };
    }
    if (!isName(tok)) return fail(`Design View can't show '${tok.text}' in FROM.`);
    const real = this.realSource(nameOf(tok));
    let end = i + 1;
    let alias: string | null = null;
    if (this.t[end]?.up === "AS" && isName(this.t[end + 1])) (alias = nameOf(this.t[end + 1])), (end += 2);
    else if (isName(this.t[end]) && end < b) (alias = nameOf(this.t[end])), (end += 1);
    if (this.tables.includes(real)) fail(`Design View can't show a query that uses '${real}' twice yet.`);
    this.tables.push(real);
    this.names.set(real.toLowerCase(), real);
    this.names.set(nameOf(tok).toLowerCase(), real);
    if (alias) {
      if (this.names.has(alias.toLowerCase()) && this.names.get(alias.toLowerCase()) !== real) fail(`The name '${alias}' is used for two tables.`);
      this.names.set(alias.toLowerCase(), real);
    }
    return { end, tables: [real] };
  }

  // ---- Columns ---------------------------------------------------------------------------

  private newColumn(c: Partial<QueryColumn> & Pick<QueryColumn, "table" | "field">): QueryColumn {
    const col: QueryColumn = { show: true, sort: "", criteria: "", ...c };
    this.columns.push(col);
    return col;
  }

  private sameColumn(c: QueryColumn, ref: Ref | { expr: string }, total: TotalOption) {
    if ((c.total ?? "Group By") !== total) return false;
    return "expr" in ref ? !!c.expr && norm(c.field) === norm(ref.expr) : !c.expr && c.table === ref.table && c.field === ref.field;
  }

  /** Reads one SELECT item into a grid column. */
  private selectItem(item: Range, index: number, groupBy: Range[]) {
    // Name: … AS [Alias]
    let alias: string | undefined;
    const parts = this.split(item, (t) => t.up === "AS");
    if (parts.length > 2) fail(`Can't read '${this.text(item)}'.`);
    if (parts.length === 2) {
      const a = parts[1];
      if (a.b - a.a !== 1 || !isName(this.t[a.a]) && this.t[a.a].kind !== "str") fail(`Can't read the column name in '${this.text(item)}'.`);
      alias = nameOf(this.t[a.a]);
      item = parts[0];
    }
    item = this.unwrap(item);
    const ref = this.refOf(item);
    const autoName = () => {
      // Keep the name SQL gave an unnamed expression, unless it can't be written as [Name].
      const n = this.opts.outputNames?.[index];
      return n && !/[[\]]/.test(n) && n.length <= 64 ? n : undefined;
    };

    if (ref === "star") {
      if (this.totals) fail("SELECT * can't be used in a totals query.");
      for (const t of this.tables) this.newColumn({ table: t, field: "*" });
      return;
    }
    if (ref && "starOf" in ref) {
      if (this.totals) fail("[Table].* can't be used in a totals query.");
      this.newColumn({ table: ref.starOf, field: "*" });
      return;
    }
    const named = (field: string) => (alias && alias !== field ? { alias } : {});

    // A total of one field (or of *): Sum([Amount]), Count(*).
    const fn = AGGREGATES[this.t[item.a].up];
    if (fn && this.t[item.a + 1]?.text === "(" && this.close(item.a + 1, item.b) === item.b - 1) {
      const arg: Range = { a: item.a + 2, b: item.b - 1 };
      if (this.t[arg.a]?.up === "DISTINCT") fail("Count(DISTINCT …) isn't Access SQL.");
      const argRef = this.refOf(arg);
      const name = alias ?? autoName();
      if (argRef === "star") {
        if (fn !== "Count") fail(`${fn}(*) isn't valid; only Count(*) is.`);
        this.newColumn({ table: this.tables[0], field: "*", total: "Count", ...(name ? { alias: name } : {}) });
      } else if (argRef && !("starOf" in argRef)) {
        this.newColumn({ table: argRef.table, field: argRef.field, total: fn, ...(name ? { alias: name } : {}) });
      } else {
        this.newColumn({ table: "", field: this.text(arg), expr: true, total: fn, ...(name ? { alias: name } : {}) });
      }
      return;
    }
    if (ref) {
      if (this.totals && !groupBy.some((g) => sameRef(this.refOf(g), ref))) fail(`[${ref.field}] must be in GROUP BY or inside a total such as Sum or Count.`);
      this.newColumn({ table: ref.table, field: ref.field, ...named(ref.field) });
      return;
    }
    // Any other expression.
    const expr = this.text(item);
    const name = alias ?? autoName();
    // In a totals query, an expression that isn't grouped by is an Expression (Access checks
    // that its fields are grouped when it runs).
    const grouped = !this.totals || groupBy.some((g) => norm(this.text(g)) === norm(expr));
    const total: TotalOption | undefined = this.hasAggregate(item) || !grouped ? "Expression" : undefined;
    this.newColumn({ table: "", field: expr, expr: true, ...(total ? { total } : {}), ...(name ? { alias: name } : {}) });
  }

  // ---- Criteria --------------------------------------------------------------------------

  /** Where a condition's left-hand side ends and its operator starts, or -1. */
  private operatorAt(r: Range): number {
    let depth = 0;
    for (let i = r.a; i < r.b; i++) {
      const tok = this.t[i];
      if (tok.text === "(") depth++;
      else if (tok.text === ")") depth--;
      else if (depth === 0 && i > r.a) {
        if (["=", "<", ">"].includes(tok.text)) return i;
        if (["LIKE", "BETWEEN", "IN", "IS"].includes(tok.up)) return i;
        if (tok.up === "NOT" && ["LIKE", "BETWEEN", "IN"].includes(this.t[i + 1]?.up)) return i;
      }
    }
    return -1;
  }

  /**
   * Puts one condition in the grid, in criteria row `row`: [City] = "Paris" becomes the City
   * column's criteria "Paris". Conditions that don't start with a field or expression go in a
   * hidden expression column as "<> False", which keeps their meaning.
   */
  private placeCondition(cond: Range, row: number, where: "where" | "having") {
    cond = this.unwrap(cond);
    // NOT binds more loosely than comparisons (NOT a = b is NOT (a = b)), so keep it whole.
    const op = this.t[cond.a].up === "NOT" ? -1 : this.operatorAt(cond);
    let target: Ref | { expr: string };
    let total: TotalOption;
    let criteria: string;
    const lhs: Range = { a: cond.a, b: op };
    const ref = op > 0 ? this.refOf(lhs) : null;
    const fn = op > 0 ? AGGREGATES[this.t[lhs.a].up] : undefined;
    const isCall = !!fn && this.t[lhs.a + 1]?.text === "(" && this.close(lhs.a + 1, lhs.b) === lhs.b - 1;

    if (op > 0) {
      const rest: Range = { a: op, b: cond.b };
      criteria = this.text(rest);
      // = "text" and = #date# read better without the =, as Access shows them.
      if (this.t[op].text === "=" && rest.b - rest.a === 2 && ["str", "date"].includes(this.t[op + 1].kind)) criteria = this.text({ a: op + 1, b: rest.b });
    } else {
      criteria = "<> False";
    }

    if (op > 0 && ref && ref !== "star" && !("starOf" in ref)) {
      target = ref;
      total = this.totals ? (where === "where" ? "Where" : "Group By") : "Group By";
    } else if (op > 0 && isCall && where === "having") {
      const arg: Range = { a: lhs.a + 2, b: lhs.b - 1 };
      const argRef = this.refOf(arg);
      total = fn!;
      target = argRef === "star" ? { table: this.tables[0], field: "*" } : argRef && !("starOf" in argRef) ? argRef : { expr: this.text(arg) };
    } else {
      const exprRange = this.unwrap(op > 0 ? lhs : cond);
      target = { expr: this.text(exprRange) };
      const agg = this.hasAggregate(exprRange);
      if (where === "where" && agg) fail("WHERE can't use totals; use HAVING.");
      total = !this.totals ? "Group By" : where === "where" ? "Where" : agg ? "Expression" : "Group By";
    }

    // Reuse a grid column for the same field and total when that criteria cell is free.
    const slot = (c: QueryColumn) => (row === 0 ? c.criteria : (c.or?.[row - 1] ?? ""));
    let col = this.columns.find((c) => this.sameColumn(c, target, total) && !slot(c) && !(total === "Where" && c.show));
    if (!col) {
      col =
        "expr" in target
          ? this.newColumn({ table: "", field: target.expr, expr: true, show: false, ...(this.totals ? { total } : {}) })
          : this.newColumn({ table: target.table, field: target.field, show: false, ...(this.totals ? { total } : {}) });
    }
    if (row === 0) col.criteria = criteria;
    else {
      const or = [...(col.or ?? [])];
      while (or.length < row) or.push("");
      or[row - 1] = criteria;
      col.or = or;
    }
  }

  // ---- ORDER BY ----------------------------------------------------------------------------

  private placeSort(item: Range, selectCols: QueryColumn[], lastSorted: { i: number }) {
    let dir: "ASC" | "DESC" = "ASC";
    const lastTok = this.t[item.b - 1];
    if (lastTok.up === "ASC" || lastTok.up === "DESC") {
      dir = lastTok.up;
      item = { a: item.a, b: item.b - 1 };
    }
    item = this.unwrap(item);
    let col: QueryColumn | undefined;
    const text = this.text(item);
    if (/^\d+$/.test(text)) {
      col = selectCols[Number(text) - 1];
      if (!col || col.field === "*") fail(`ORDER BY ${text}: there's no column ${text} to sort by.`);
    }
    if (!col && item.b - item.a === 1) {
      const n = nameOf(this.t[item.a]).toLowerCase();
      col = selectCols.find((c) => c.alias?.toLowerCase() === n);
    }
    let make: Partial<QueryColumn> & Pick<QueryColumn, "table" | "field">;
    if (!col) {
      const ref = this.refOf(item);
      const fn = AGGREGATES[this.t[item.a].up];
      if (ref && ref !== "star" && !("starOf" in ref)) {
        const total: TotalOption = "Group By";
        col = this.columns.find((c) => this.sameColumn(c, ref, total) && c.show);
        make = { table: ref.table, field: ref.field };
        if (this.totals && !col && !this.columns.some((c) => this.sameColumn(c, ref, total))) fail(`ORDER BY [${ref.field}]: it must be in GROUP BY.`);
      } else if (fn && this.t[item.a + 1]?.text === "(" && this.close(item.a + 1, item.b) === item.b - 1) {
        const arg: Range = { a: item.a + 2, b: item.b - 1 };
        const argRef = this.refOf(arg);
        const target = argRef === "star" ? { table: this.tables[0], field: "*" } : argRef && !("starOf" in argRef) ? argRef : { expr: this.text(arg) };
        col = this.columns.find((c) => this.sameColumn(c, target, fn) && c.show);
        make = "expr" in target ? { table: "", field: target.expr, expr: true, total: fn } : { ...target, total: fn };
      } else {
        const grouped = this.columns.some((c) => this.sameColumn(c, { expr: text }, "Group By"));
        const total: TotalOption = this.hasAggregate(item) || (this.totals && !grouped) ? "Expression" : "Group By";
        col = this.columns.find((c) => this.sameColumn(c, { expr: text }, total) && c.show);
        make = { table: "", field: text, expr: true, ...(this.totals ? { total } : {}) };
      }
    } else {
      make = { table: col.table, field: col.field, ...(col.expr ? { expr: true } : {}), ...(col.total ? { total: col.total } : {}) };
    }
    // Access sorts by the grid's sorted columns from left to right, so a sort key that comes
    // earlier in the grid (or is already sorted) gets a hidden copy at the end.
    const idx = col ? this.columns.indexOf(col) : -1;
    if (col && idx > lastSorted.i && !col.sort) {
      col.sort = dir;
      lastSorted.i = idx;
      return;
    }
    const copy = this.newColumn({ ...make!, show: false, sort: dir });
    if (this.totals && copy.total === undefined) copy.total = "Group By";
    lastSorted.i = this.columns.length - 1;
  }

  // ---- The statement -----------------------------------------------------------------------

  parse(): QueryDesign {
    const t = this.t;
    let end = t.length;
    while (end > 0 && t[end - 1].text === ";") end--;
    if (!end) fail("The query is empty.");
    const first = t[0].up;
    if (first === "PARAMETERS") fail("Design View can't show queries with PARAMETERS yet.");
    if (first === "TRANSFORM") fail("Design View can only read select queries from SQL so far, not crosstab queries.");
    if (first !== "SELECT") fail("Design View can only read select queries from SQL so far.");

    // Find the clauses at bracket depth 0.
    const at: Record<string, number> = {};
    let depth = 0;
    for (let i = 1; i < end; i++) {
      const w = t[i].up;
      if (t[i].text === "(") depth++;
      else if (t[i].text === ")") depth--;
      else if (w === "SELECT") fail(depth ? "Design View can't show subqueries yet." : "Design View can't show this query yet.");
      else if (depth === 0) {
        if (w === "UNION") fail("Union queries can only be edited in SQL View.");
        if (w === "INTO") fail("Design View can only read select queries from SQL so far (this one makes a table).");
        if (w === "WITH" && t[i + 1]?.up === "OWNERACCESS") fail("Design View can't show WITH OWNERACCESS OPTION yet.");
        if (CLAUSES.includes(w)) {
          if ((w === "GROUP" || w === "ORDER") && t[i + 1]?.up !== "BY") fail(`${w} must be followed by BY.`);
          if (at[w] !== undefined) fail(`${w} appears twice.`);
          at[w] = i;
        }
      }
    }
    if (at.FROM === undefined) fail("The query needs a FROM clause.");
    const order = CLAUSES.filter((c) => at[c] !== undefined);
    for (let k = 1; k < order.length; k++) if (at[order[k]] < at[order[k - 1]]) fail(`${order[k]} must come after ${order[k - 1]}.`);
    const clause = (name: string): Range | null => {
      if (at[name] === undefined) return null;
      const startTok = at[name] + (name === "GROUP" || name === "ORDER" ? 2 : 1);
      const next = order.slice(order.indexOf(name) + 1).map((c) => at[c]);
      return { a: startTok, b: next.length ? next[0] : end };
    };

    let selectStart = 1;
    let distinct = false;
    if (t[1]?.up === "DISTINCT") (distinct = true), selectStart++;
    else if (t[1]?.up === "ALL") selectStart++;
    else if (t[1]?.up === "DISTINCTROW") fail("Design View can't show DISTINCTROW yet. DISTINCT (Unique Values) works.");
    if (t[selectStart]?.up === "TOP") fail("Design View can't show TOP (Return) yet.");

    this.parseFrom(clause("FROM")!);

    const selectRange: Range = { a: selectStart, b: at.FROM };
    const items = this.split(selectRange, (x) => x.text === ",");
    if (!items.length) fail("SELECT has no columns.");
    const groupBy = clause("GROUP") ? this.split(clause("GROUP")!, (x) => x.text === ",") : [];
    const having = clause("HAVING");
    this.totals = groupBy.length > 0 || !!having || items.some((r) => this.hasAggregate(r));

    // With a * in the list, output positions don't line up with the items, so names can't be matched.
    if (items.some((r) => this.t[r.b - 1].text === "*" && (r.b - r.a === 1 || this.t[r.b - 2].text === "."))) this.opts = { ...this.opts, outputNames: undefined };
    items.forEach((item, i) => this.selectItem(item, i, groupBy));
    const selectCols = [...this.columns];

    // GROUP BY fields that aren't shown become hidden Group By columns.
    for (const g of groupBy) {
      const ref = this.refOf(g);
      if (ref === "star" || (ref && "starOf" in ref)) fail("GROUP BY can't use *.");
      const target: Ref | { expr: string } = ref && ref !== "star" && !("starOf" in ref) ? ref : { expr: this.text(this.unwrap(g)) };
      if (!this.columns.some((c) => this.sameColumn(c, target, "Group By"))) {
        this.newColumn("expr" in target ? { table: "", field: target.expr, expr: true, show: false, total: "Group By" } : { ...target, show: false, total: "Group By" });
      }
    }
    if (this.totals) for (const c of this.columns) c.total ??= "Group By";

    const where = clause("WHERE");
    if (where) {
      // Without totals, OR splits into the Criteria and or: rows, like Access shows them.
      const rows = this.totals ? [where] : this.split(this.unwrap(where), (x) => x.up === "OR");
      if (rows.length > 21) fail("WHERE has more than 21 OR'd conditions, more than the grid's rows.");
      if (this.totals && this.split(this.unwrap(where), (x) => x.up === "OR").length > 1) this.placeCondition(where, 0, "where");
      else rows.forEach((r, row) => this.split(this.unwrap(r), (x) => x.up === "AND").forEach((c) => this.placeCondition(c, row, "where")));
    }
    if (having) {
      if (this.split(this.unwrap(having), (x) => x.up === "OR").length > 1) this.placeCondition(having, 0, "having");
      else this.split(this.unwrap(having), (x) => x.up === "AND").forEach((c) => this.placeCondition(c, 0, "having"));
    }

    const orderBy = clause("ORDER");
    if (orderBy) {
      const last = { i: -1 };
      for (const item of this.split(orderBy, (x) => x.text === ",")) this.placeSort(item, selectCols, last);
    }

    // Tidy: drop empty or: rows at the end of each column.
    for (const c of this.columns) {
      if (c.or) {
        while (c.or.length && !c.or[c.or.length - 1]) c.or.pop();
        if (!c.or.length) delete c.or;
      }
    }
    const design: QueryDesign = { tables: this.tables, columns: this.columns, joins: this.joins };
    if (this.totals) design.totals = true;
    if (distinct) design.distinct = true;
    return design;
  }
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function sameRef(a: RefResult, b: Ref): boolean {
  return !!a && a !== "star" && !("starOf" in a) && a.table === b.table && a.field === b.field;
}
