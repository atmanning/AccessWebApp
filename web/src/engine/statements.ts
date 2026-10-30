/**
 * Splits Access SQL statements into their parts so action queries (UPDATE, DELETE,
 * INSERT INTO, SELECT ... INTO) and crosstabs (TRANSFORM ... PIVOT) can be run here.
 * Works on the text the user typed or the designer generated, so imported Access
 * queries run too.
 */
import type { QueryType } from "../../../shared/model";
import { SqlSyntaxError, tokenize, type Token } from "./accessSql";

export type Statement =
  | { kind: "select"; sql: string }
  | { kind: "crosstab"; value: string; select: string; pivot: string; pivotIn?: string[] }
  | { kind: "makeTable"; target: string; select: string }
  | { kind: "append"; target: string; columns: string[] | null; select: string }
  | { kind: "update"; from: string; sets: { qualifier?: string; field: string; expr: string }[]; where?: string }
  | { kind: "delete"; from: string; qualifier?: string; where?: string };

const KIND_TO_TYPE: Record<Statement["kind"], QueryType> = {
  select: "select",
  crosstab: "crosstab",
  makeTable: "makeTable",
  append: "append",
  update: "update",
  delete: "delete",
};

const name = (t: Token | undefined) => (t ? (t.kind === "ident" ? t.text.slice(1, -1) : t.text) : "");
const up = (t: Token | undefined) => (t && t.kind === "word" ? t.text.toUpperCase() : "");

export function parseStatement(input: string): Statement {
  const sql = input.trim().replace(/;\s*$/, "");
  const toks = tokenize(sql).filter((t) => t.kind !== "ws");
  if (!toks.length) throw new SqlSyntaxError("The query is empty.");
  // Top-level keyword positions.
  const depthAt: number[] = [];
  let d = 0;
  for (const t of toks) {
    if (t.text === ")") d--;
    depthAt.push(d);
    if (t.text === "(") d++;
  }
  const find = (word: string, from = 0, to = toks.length) => {
    for (let i = from; i < to; i++) if (depthAt[i] === 0 && up(toks[i]) === word) return i;
    return -1;
  };
  const text = (from: number, to = toks.length) => (from >= to ? "" : sql.slice(toks[from].start, to < toks.length ? toks[to].start : sql.length).trim());
  const first = up(toks[0]);

  if (first === "PARAMETERS") throw new SqlSyntaxError("Parameter queries (PARAMETERS ...) aren't supported yet.");

  if (first === "TRANSFORM") {
    const s = find("SELECT");
    const p = find("PIVOT");
    if (s < 0 || p < 0) throw new SqlSyntaxError("A crosstab query needs TRANSFORM ... SELECT ... PIVOT ....");
    // The value expression, without its "AS alias".
    let valueEnd = s;
    const as = find("AS", 1, s);
    if (as > 0) valueEnd = as;
    const inAt = find("IN", p + 1);
    let pivotIn: string[] | undefined;
    if (inAt > 0 && toks[inAt + 1]?.text === "(") {
      pivotIn = [];
      for (let i = inAt + 2; i < toks.length && toks[i].text !== ")"; i++) {
        if (toks[i].text !== ",") pivotIn.push(toks[i].kind === "str" ? toks[i].text : name(toks[i]));
      }
    }
    return { kind: "crosstab", value: text(1, valueEnd), select: text(s, p), pivot: text(p + 1, inAt > 0 ? inAt : toks.length), pivotIn };
  }

  if (first === "SELECT") {
    const into = find("INTO");
    const from = find("FROM");
    if (into > 0 && (from < 0 || into < from)) {
      const target = name(toks[into + 1]);
      if (!target) throw new SqlSyntaxError("SELECT ... INTO needs the name of the new table.");
      return { kind: "makeTable", target, select: `${text(0, into)} ${text(into + 2)}`.trim() };
    }
    return { kind: "select", sql };
  }

  if (first === "INSERT") {
    if (up(toks[1]) !== "INTO") throw new SqlSyntaxError("Append queries start with INSERT INTO.");
    const target = name(toks[2]);
    let i = 3;
    let columns: string[] | null = null;
    if (toks[i]?.text === "(" && up(toks[i + 1]) !== "SELECT") {
      columns = [];
      for (i = i + 1; i < toks.length && toks[i].text !== ")"; i++) if (toks[i].text !== ",") columns.push(name(toks[i]));
      i++;
    }
    if (up(toks[i]) === "VALUES") {
      // INSERT ... VALUES (a, b) is the same as selecting those values once.
      const open = i + 1;
      const close = toks.findIndex((t, k) => k > open && t.text === ")" && depthAt[k] === 0);
      return { kind: "append", target, columns, select: `SELECT ${text(open + 1, close)}` };
    }
    if (up(toks[i]) !== "SELECT") throw new SqlSyntaxError("INSERT INTO needs a SELECT or VALUES part.");
    return { kind: "append", target, columns, select: text(i) };
  }

  if (first === "UPDATE") {
    const set = find("SET");
    if (set < 0) throw new SqlSyntaxError("UPDATE needs a SET clause.");
    const where = find("WHERE", set);
    const end = where > 0 ? where : toks.length;
    const sets: { qualifier?: string; field: string; expr: string }[] = [];
    let start = set + 1;
    for (let k = set + 1; k <= end; k++) {
      if (k < end && !(toks[k].text === "," && depthAt[k] === 0)) continue;
      const eq = toks.findIndex((t, j) => j >= start && j < k && t.text === "=" && depthAt[j] === 0);
      if (eq < 0) throw new SqlSyntaxError("Each SET item needs field = value.");
      const lhs = toks.slice(start, eq);
      const field = lhs.length === 3 && lhs[1].text === "." ? { qualifier: name(lhs[0]), field: name(lhs[2]) } : { field: name(lhs[0]) };
      sets.push({ ...field, expr: text(eq + 1, k) });
      start = k + 1;
    }
    return { kind: "update", from: text(1, set), sets, where: where > 0 ? text(where + 1) : undefined };
  }

  if (first === "DELETE") {
    const from = find("FROM");
    if (from < 0) throw new SqlSyntaxError("DELETE needs a FROM clause.");
    const where = find("WHERE", from);
    // DELETE [T].* FROM ... names the table to delete from.
    const qualifier = from >= 3 && toks[2]?.text === "." ? name(toks[1]) : undefined;
    return { kind: "delete", from: text(from + 1, where > 0 ? where : toks.length), qualifier, where: where > 0 ? text(where + 1) : undefined };
  }

  if (first === "WITH") return { kind: "select", sql };
  throw new SqlSyntaxError(`Queries that start with ${toks[0].text} aren't supported here.`);
}

/** The query type of some SQL; anything unreadable counts as a select query. */
export function queryTypeOf(sql: string): QueryType {
  try {
    return KIND_TO_TYPE[parseStatement(sql).kind];
  } catch {
    return "select";
  }
}

export const isActionType = (t: QueryType) => t === "makeTable" || t === "append" || t === "update" || t === "delete";
