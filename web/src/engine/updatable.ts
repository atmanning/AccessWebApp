/**
 * Works out whether a SELECT query's results can be edited, the way Access decides if a
 * query is "updatable", and which table field each result column comes from.
 *
 * Editable: queries that read from tables (joins allowed) and whose columns are plain
 * field references (`[T].[F]`, `T.F`, `F`, `T.*`, `*`, optionally with an alias).
 * Read-only: DISTINCT, GROUP BY, HAVING, UNION, totals (Sum, Count, ...), subqueries,
 * queries based on other queries, and calculated columns (those stay read-only even
 * when the rest of the query is editable).
 */
import type { Field, ProjectDoc, TableDef } from "../../../shared/model";
import { tokenize, type Token } from "./accessSql";

export interface ColumnOrigin {
  /** Index into `sources`. */
  source: number;
  field: Field;
}

export type UpdatableInfo =
  | { ok: false; reason: string }
  | {
      ok: true;
      sources: { table: TableDef; alias: string }[];
      /** One entry per result column; null for calculated (read-only) columns. */
      columns: (ColumnOrigin | null)[];
      /** The query with one hidden rowid column per source appended to the SELECT list. */
      sql: string;
    };

export const RID_PREFIX = "__rid_";

const AGGREGATES = new Set(["SUM", "COUNT", "AVG", "MIN", "MAX", "FIRST", "LAST", "STDEV", "STDEVP", "VAR", "VARP"]);
const JOIN_WORDS = new Set(["INNER", "LEFT", "RIGHT", "OUTER", "FULL", "CROSS", "JOIN"]);
const CLAUSE_END = new Set(["WHERE", "GROUP", "ORDER", "HAVING", "UNION", "WITH", "LIMIT"]);

const unbracket = (t: Token) => (t.kind === "ident" ? t.text.slice(1, -1) : t.text);
const isName = (t: Token | undefined) => !!t && (t.kind === "ident" || t.kind === "word");
const up = (t: Token | undefined) => (t && t.kind === "word" ? t.text.toUpperCase() : "");

export function analyzeUpdatable(doc: ProjectDoc, accessSql: string): UpdatableInfo {
  let all: Token[];
  try {
    all = tokenize(accessSql);
  } catch {
    return { ok: false, reason: "The query's SQL couldn't be read." };
  }
  const toks = all.filter((t) => t.kind !== "ws");
  const notUpdatable = (why: string): UpdatableInfo => ({ ok: false, reason: `This query's results can't be edited because ${why}.` });

  // Top-level keyword positions (outside parentheses).
  let depth = 0;
  let selectAt = -1;
  let fromAt = -1;
  let fromEnd = toks.length;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.text === "(") depth++;
    else if (t.text === ")") depth--;
    const w = up(t);
    if (w === "SELECT" && depth > 0) return notUpdatable("it contains a subquery");
    if (depth !== 0) continue;
    if (w === "UNION") return notUpdatable("it is a union query");
    if (w === "GROUP" || w === "HAVING") return notUpdatable("it groups or totals records");
    if (w === "TRANSFORM" || w === "PIVOT") return notUpdatable("it is a crosstab query");
    if (w === "SELECT" && selectAt < 0) selectAt = i;
    else if (w === "FROM" && fromAt < 0) fromAt = i;
    else if (fromAt >= 0 && fromEnd === toks.length && CLAUSE_END.has(w)) fromEnd = i;
  }
  if (selectAt !== 0 || fromAt < 0) return notUpdatable("it isn't a simple select query");

  // ---- FROM: table references and aliases ----
  const sources: { table: TableDef; alias: string }[] = [];
  let expectTable = true;
  let inOn = false;
  let onDepth = 0;
  for (let i = fromAt + 1; i < fromEnd; i++) {
    const t = toks[i];
    const w = up(t);
    if (inOn) {
      if (t.text === "(") onDepth++;
      else if (t.text === ")") {
        if (onDepth === 0) inOn = false; // closes a join group
        else onDepth--;
      } else if (onDepth === 0 && (JOIN_WORDS.has(w) || t.text === ",")) {
        inOn = false;
        expectTable = true;
      }
      continue;
    }
    if (t.text === "(") {
      if (up(toks[i + 1]) === "SELECT") return notUpdatable("it contains a subquery");
      expectTable = true;
      continue;
    }
    if (t.text === "," || w === "JOIN") {
      expectTable = true;
      continue;
    }
    if (JOIN_WORDS.has(w) || t.text === ")") continue;
    if (w === "ON") {
      inOn = true;
      onDepth = 0;
      continue;
    }
    if (expectTable && isName(t)) {
      const name = unbracket(t);
      const table = doc.tables.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!table) {
        if (doc.queries.some((q) => q.name.toLowerCase() === name.toLowerCase())) return notUpdatable(`it is based on the query '${name}'`);
        if (doc.linkedTables?.some((l) => l.name.toLowerCase() === name.toLowerCase())) return notUpdatable(`it uses the linked table '${name}', which is read-only`);
        return notUpdatable(`'${name}' isn't a table`);
      }
      let alias = table.name;
      let j = i + 1;
      if (up(toks[j]) === "AS") j++;
      if (isName(toks[j]) && !JOIN_WORDS.has(up(toks[j])) && up(toks[j]) !== "ON" && !CLAUSE_END.has(up(toks[j]))) {
        alias = unbracket(toks[j]);
        i = j;
      }
      sources.push({ table, alias });
      expectTable = false;
    }
  }
  if (!sources.length) return notUpdatable("it doesn't read from a table");

  /** A qualifier can be an alias or, when not aliased, the table name. */
  const findSource = (qualifier: string) => {
    const q = qualifier.toLowerCase();
    const byAlias = sources.findIndex((s) => s.alias.toLowerCase() === q);
    return byAlias >= 0 ? byAlias : sources.findIndex((s) => s.table.name.toLowerCase() === q);
  };

  // ---- SELECT list ----
  let start = selectAt + 1;
  if (up(toks[start]) === "DISTINCT" || up(toks[start]) === "DISTINCTROW") return notUpdatable("it uses DISTINCT");
  if (up(toks[start]) === "ALL") start++;
  if (up(toks[start]) === "TOP") start += 2;
  const items: Token[][] = [[]];
  depth = 0;
  for (let i = start; i < fromAt; i++) {
    const t = toks[i];
    if (t.text === "(") depth++;
    if (t.text === ")") depth--;
    if (t.text === "," && depth === 0) items.push([]);
    else items[items.length - 1].push(t);
  }

  const columns: (ColumnOrigin | null)[] = [];
  for (const item of items) {
    // Totals anywhere in the select list make the whole query read-only.
    for (let k = 0; k < item.length - 1; k++) {
      if (AGGREGATES.has(up(item[k])) && item[k + 1].text === "(") return notUpdatable("it totals records");
    }
    // Strip a trailing alias: "... AS x" or "... x" after a field reference.
    let expr = item;
    if (expr.length >= 3 && up(expr[expr.length - 2]) === "AS") expr = expr.slice(0, -2);
    else if (expr.length === 4 && isName(expr[3]) && expr[1].text === ".") expr = expr.slice(0, 3);
    else if (expr.length === 2 && isName(expr[0]) && isName(expr[1])) expr = expr.slice(0, 1);

    if (expr.length === 1 && expr[0].text === "*") {
      sources.forEach((s, si) => s.table.fields.forEach((f) => columns.push({ source: si, field: f })));
    } else if (expr.length === 3 && isName(expr[0]) && expr[1].text === "." && expr[2].text === "*") {
      const si = findSource(unbracket(expr[0]));
      if (si < 0) return notUpdatable(`'${unbracket(expr[0])}' isn't one of its tables`);
      sources[si].table.fields.forEach((f) => columns.push({ source: si, field: f }));
    } else if (expr.length === 3 && isName(expr[0]) && expr[1].text === "." && isName(expr[2])) {
      const si = findSource(unbracket(expr[0]));
      const f = si >= 0 ? sources[si].table.fields.find((x) => x.name.toLowerCase() === unbracket(expr[2]).toLowerCase()) : undefined;
      columns.push(f ? { source: si, field: f } : null);
    } else if (expr.length === 1 && isName(expr[0])) {
      const name = unbracket(expr[0]).toLowerCase();
      const hits = sources.flatMap((s, si) => s.table.fields.filter((f) => f.name.toLowerCase() === name).map((f) => ({ source: si, field: f })));
      columns.push(hits.length === 1 ? hits[0] : null);
    } else {
      columns.push(null); // calculated column
    }
  }

  // Append one hidden rowid per source, just before FROM.
  const fromOffset = toks[fromAt].start;
  const rid = sources.map((s, i) => `[${s.alias}].rowid AS ${RID_PREFIX}${i}`).join(", ");
  const sql = `${accessSql.slice(0, fromOffset).replace(/\s*$/, "")}, ${rid} ${accessSql.slice(fromOffset)}`;
  return { ok: true, sources, columns, sql };
}
