import type { Field, ProjectDoc, QueryColumn, QueryDef, TotalOption } from "../../../shared/model";
import { br, parseAccessDate } from "./accessSql";

/** Turns one Criteria cell from the design grid into an Access SQL condition. */
export function criteriaToSql(column: string, criteria: string, field?: Field): string | null {
  const c = criteria.trim();
  if (!c) return null;
  if (/^(=|<>|<=|>=|<|>)/.test(c)) return `${column} ${c}`;
  if (/^(like|not|is|between|in)\b/i.test(c)) return `${column} ${c}`;
  if (field?.type === "YesNo") {
    if (/^(yes|true|-1|on)$/i.test(c)) return `${column} = True`;
    if (/^(no|false|0|off)$/i.test(c)) return `${column} = False`;
  }
  if (/^[-+]?\d+(\.\d+)?$/.test(c) && field?.type !== "ShortText" && field?.type !== "LongText") return `${column} = ${c}`;
  if (/^#.*#$/.test(c)) return `${column} = ${c}`;
  if (field?.type === "DateTime" && parseAccessDate(c)) return `${column} = #${c}#`;
  if (/^".*"$/.test(c)) return `${column} = ${c}`;
  if (c.includes("*") || c.includes("?")) return `${column} Like "${c.replace(/"/g, '""')}"`;
  return `${column} = "${c.replace(/"/g, '""')}"`;
}

export type JoinKind = "inner" | "left" | "right";

/** A join line between two tables in Design View. */
export interface DesignJoin {
  /** Stable key for drawing and selecting the line. */
  key: string;
  fromTable: string;
  fromField: string;
  toTable: string;
  toField: string;
  /** inner; left = all records from fromTable; right = all records from toTable. */
  kind: JoinKind;
  /** Referential integrity is enforced by a matching relationship: the line shows 1 and ∞ like Access. */
  enforce: boolean;
  /** Index in design.joins, when the design lists its joins. */
  index?: number;
}

type ExplicitJoins = QueryDesign["joins"];

/** The relationship between two fields, either way round. */
function relationshipBetween(doc: ProjectDoc, t1: string, f1: string, t2: string, f2: string) {
  const ids = (t: string, f: string) => {
    const table = doc.tables.find((x) => x.name === t);
    return { t: table?.id, f: table?.fields.find((x) => x.name === f)?.id };
  };
  const a = ids(t1, f1);
  const b = ids(t2, f2);
  return doc.relationships.find(
    (r) => (r.fromTable === a.t && r.fromField === a.f && r.toTable === b.t && r.toField === b.f) || (r.fromTable === b.t && r.fromField === b.f && r.toTable === a.t && r.toField === a.f),
  );
}

/**
 * Joins Access makes automatically from relationships: each table after the first joins to an
 * earlier one through a relationship. Tables with no relationship to the others are left unjoined.
 */
export function relationshipJoins(doc: ProjectDoc, tableNames: string[], alreadyJoined: string[] = []): DesignJoin[] {
  const joins: DesignJoin[] = [];
  const joined = new Set(alreadyJoined.length ? alreadyJoined : tableNames.slice(0, 1));
  for (const name of tableNames) {
    if (joined.has(name)) continue;
    const t = doc.tables.find((x) => x.name === name);
    const rel = t
      ? doc.relationships.find((r) => {
          const other = r.fromTable === t.id ? r.toTable : r.toTable === t.id ? r.fromTable : null;
          const otherT = doc.tables.find((x) => x.id === other);
          return otherT && joined.has(otherT.name);
        })
      : undefined;
    const from = rel && doc.tables.find((x) => x.id === rel.fromTable);
    const to = rel && doc.tables.find((x) => x.id === rel.toTable);
    const ff = rel && from?.fields.find((f) => f.id === rel.fromField);
    const tf = rel && to?.fields.find((f) => f.id === rel.toField);
    if (!rel || !from || !to || !ff || !tf) continue;
    joins.push({ key: rel.id, fromTable: from.name, fromField: ff.name, toTable: to.name, toField: tf.name, kind: "inner", enforce: rel.enforce });
    joined.add(name);
  }
  return joins;
}

/**
 * The joins of a design: the ones it lists, or (for designs that don't list them) the ones its
 * relationships make. `unjoined` are tables with no join to the first table's group.
 */
export function designJoins(doc: ProjectDoc, tableNames: string[], explicit?: ExplicitJoins): { joins: DesignJoin[]; unjoined: string[] } {
  const joins: DesignJoin[] = explicit
    ? explicit
        .filter((j) => tableNames.includes(j.t1) && tableNames.includes(j.t2))
        .map((j, index) => ({
          key: `j${index}:${j.t1}.${j.f1}=${j.t2}.${j.f2}`,
          fromTable: j.t1,
          fromField: j.f1,
          toTable: j.t2,
          toField: j.f2,
          kind: j.kind,
          enforce: !!relationshipBetween(doc, j.t1, j.f1, j.t2, j.f2)?.enforce,
          index: explicit.indexOf(j),
        }))
    : relationshipJoins(doc, tableNames);
  const linked = new Set(tableNames.slice(0, 1));
  for (let grew = true; grew; ) {
    grew = false;
    for (const j of joins) {
      if (linked.has(j.fromTable) !== linked.has(j.toTable)) {
        linked.add(j.fromTable);
        linked.add(j.toTable);
        grew = true;
      }
    }
  }
  return { joins, unjoined: tableNames.filter((t) => !linked.has(t)) };
}

/**
 * FROM clause in Access's style: (A INNER JOIN B ON …) LEFT JOIN C ON …, adding tables in the
 * order they were added to the design. Tables not joined to the others are listed after commas.
 */
function fromClause(doc: ProjectDoc, tableNames: string[], explicit?: ExplicitJoins): string {
  if (!tableNames.length) return "";
  const { joins } = designJoins(doc, tableNames, explicit);
  const groups: string[] = [];
  const remaining = [...tableNames];
  while (remaining.length) {
    const first = remaining.shift()!;
    const joined = new Set([first]);
    let sql = br(first);
    let count = 0;
    for (let progress = true; progress; ) {
      progress = false;
      for (const name of remaining) {
        const conds = joins.filter((j) => (j.fromTable === name && joined.has(j.toTable)) || (j.toTable === name && joined.has(j.fromTable)));
        if (!conds.length) continue;
        const j = conds[0];
        const newIsFrom = j.fromTable === name;
        // LEFT/RIGHT are relative to the line's tables; turn them round when the new table is fromTable.
        const kind = j.kind === "inner" ? "INNER" : (j.kind === "left") !== newIsFrom ? "LEFT" : "RIGHT";
        const on = conds.map((c) => `${br(c.fromTable)}.${br(c.fromField)} = ${br(c.toTable)}.${br(c.toField)}`);
        if (count > 0) sql = `(${sql})`;
        sql += ` ${kind} JOIN ${br(name)} ON ${on.length > 1 ? on.map((o) => `(${o})`).join(" AND ") : on[0]}`;
        joined.add(name);
        remaining.splice(remaining.indexOf(name), 1);
        count++;
        progress = true;
        break;
      }
    }
    groups.push(sql);
  }
  return groups.join(", ");
}

export type QueryDesign = NonNullable<QueryDef["design"]>;

/** Access names aggregate columns like SumOfAmount. */
const aggAlias = (total: TotalOption, field: string) => `${total}Of${field === "*" ? "All" : field}`.replace(/[.!`[\]\s]/g, "");

/**
 * Checks a design for problems that would stop it producing a runnable query,
 * worded like Access's messages. Returns null when it's fine.
 */
export function designProblem(doc: ProjectDoc, design: QueryDesign): string | null {
  const type = design.type ?? "select";
  const used = design.columns.filter((c) => c.field);
  if (!design.tables.length) return "Add a table with Show Table.";
  if (type === "makeTable" && !design.target?.trim()) return "Choose a name for the new table (Query Type: Make Table).";
  if (type === "append") {
    if (!design.target) return "Choose the table to append to (Query Type: Append).";
    if (!doc.tables.some((t) => t.name === design.target)) return `The table '${design.target}' to append to doesn't exist.`;
    if (!used.some((c) => c.appendTo)) return "Pick a field in the Append To row for at least one column.";
  }
  if (type === "update" && !used.some((c) => c.updateTo?.trim())) return "Type a value or expression in the Update To row for at least one field.";
  if (type === "delete" && design.tables.length > 1 && !used.some((c) => c.field === "*")) {
    return "Add the [Table].* field of the table to delete from (it shows as Delete: From).";
  }
  if (type === "crosstab") {
    const roles = used.map((c) => c.crosstab ?? "");
    if (!roles.includes("row")) return "A crosstab query needs at least one Row Heading.";
    if (roles.filter((r) => r === "column").length !== 1) return "A crosstab query needs exactly one Column Heading.";
    if (roles.filter((r) => r === "value").length !== 1) return "A crosstab query needs exactly one Value.";
    const value = used.find((c) => c.crosstab === "value")!;
    if (!value.total || value.total === "Group By" || value.total === "Where") return "Set the Value column's Total to Sum, Count, Avg or another total.";
    if (used.some((c) => (c.crosstab === "row" || c.crosstab === "column") && (c.total ?? "Group By") !== "Group By")) {
      return "Row and Column Headings must have Total set to Group By.";
    }
  }
  return null;
}

/** Builds Access SQL from the query design grid, for every query type. */
export function designSql(doc: ProjectDoc, design: QueryDesign): string {
  const type = design.type ?? "select";
  const tables = design.tables;
  if (!tables.length) return "";
  const used = design.columns.filter((c) => c.field);
  const fieldOf = (c: QueryColumn) => (c.expr ? undefined : doc.tables.find((t) => t.name === c.table)?.fields.find((f) => f.name === c.field));
  const colRef = (c: QueryColumn) => (c.expr ? c.field : c.field === "*" ? `${br(c.table)}.*` : `${br(c.table)}.${br(c.field)}`);
  const totals = type === "crosstab" || (design.totals && (type === "select" || type === "makeTable" || type === "append"));
  const totalOf = (c: QueryColumn): TotalOption => (totals ? (c.total ?? "Group By") : "Group By");
  /** Aggregated columns: a total such as Sum, or an Expression that contains its own totals. */
  const isAgg = (c: QueryColumn) => totals && !["Group By", "Where"].includes(totalOf(c));
  const aggExpr = (c: QueryColumn) => (totalOf(c) === "Expression" ? c.field : `${totalOf(c)}(${c.field === "*" ? "*" : colRef(c)})`);
  /** The column as it appears in SELECT: plain, or wrapped in its total, with its name. */
  const selectExpr = (c: QueryColumn) => {
    if (!isAgg(c)) return c.alias ? `${colRef(c)} AS ${br(c.alias)}` : colRef(c);
    const t = totalOf(c);
    const name = c.alias ?? (t === "Expression" ? undefined : aggAlias(t, c.field));
    return name ? `${aggExpr(c)} AS ${c.alias ? br(name) : name}` : aggExpr(c);
  };

  // Criteria rows: Criteria, then the "or:" rows. Each row ANDs its cells; the rows are ORed.
  const rowCount = 1 + Math.max(0, ...used.map((c) => c.or?.length ?? 0));
  const whereRows: string[][] = [];
  const havingRows: string[][] = [];
  for (let r = 0; r < rowCount; r++) {
    const w: string[] = [];
    const h: string[] = [];
    for (const c of used) {
      if (c.field === "*" && !isAgg(c)) continue;
      const crit = r === 0 ? c.criteria : (c.or?.[r - 1] ?? "");
      // An expression is bracketed so its criteria apply to all of it: ([a] Or [b]) <> False.
      const wrap = (e: string) => (c.expr ? `(${e})` : e);
      if (isAgg(c)) {
        const x = criteriaToSql(wrap(aggExpr(c)), crit, fieldOf(c));
        if (x) h.push(x);
      } else {
        const x = criteriaToSql(wrap(colRef(c)), crit, fieldOf(c));
        if (x) w.push(x);
      }
    }
    whereRows.push(w);
    havingRows.push(h);
  }
  const and = (parts: string[]) => parts.map((w) => (parts.length > 1 ? `(${w})` : w)).join(" AND ");
  const or = (rows: string[][]) => {
    const filled = rows.filter((r) => r.length).map(and);
    return filled.length > 1 ? filled.map((f) => `(${f})`).join(" OR ") : (filled[0] ?? "");
  };
  const whereSql = or(whereRows);
  const havingSql = or(havingRows);
  const from = `FROM ${fromClause(doc, tables, design.joins)}`;
  const where = whereSql ? `WHERE ${whereSql}` : "";
  const order = used
    .filter((c) => c.sort && (c.field !== "*" || isAgg(c)) && !(type === "crosstab" && c.crosstab === "column"))
    .map((c) => `${isAgg(c) ? aggExpr(c) : colRef(c)} ${c.sort}`);
  const orderBy = order.length ? `ORDER BY ${order.join(", ")}` : "";
  // A crosstab's column heading goes in PIVOT, not GROUP BY.
  const groupCols = used.filter((c) => totals && totalOf(c) === "Group By" && c.field !== "*" && !(type === "crosstab" && c.crosstab === "column"));
  const groupBy = totals && groupCols.length ? `GROUP BY ${groupCols.map(colRef).join(", ")}` : "";
  const having = havingSql ? `HAVING ${havingSql}` : "";
  const lines = (...parts: string[]) => parts.filter(Boolean).join("\n") + ";";
  const distinct = design.distinct && (type === "select" || type === "makeTable" || type === "append") ? "DISTINCT " : "";

  switch (type) {
    case "update": {
      const sets = used.filter((c) => c.updateTo?.trim() && c.field !== "*" && !c.expr).map((c) => `${colRef(c)} = ${c.updateTo!.trim()}`);
      return lines(`UPDATE ${fromClause(doc, tables, design.joins)}`, `SET ${sets.join(", ")}`, where);
    }
    case "delete": {
      const star = used.find((c) => c.field === "*");
      return lines(`DELETE ${br(star?.table ?? tables[0])}.*`, from, where);
    }
    case "append": {
      const cols = used.filter((c) => c.appendTo);
      return lines(
        `INSERT INTO ${br(design.target ?? "")} (${cols.map((c) => br(c.appendTo!)).join(", ")})`,
        `SELECT ${distinct}${cols.map(selectExpr).join(", ")}`,
        from,
        where,
        groupBy,
        having,
        orderBy,
      );
    }
    case "crosstab": {
      const value = used.find((c) => c.crosstab === "value");
      const column = used.find((c) => c.crosstab === "column");
      const rows = used.filter((c) => c.crosstab === "row");
      if (!value || !column || !rows.length) return "";
      return lines(
        `TRANSFORM ${aggExpr(value)} AS ${value.alias ? br(value.alias) : aggAlias(totalOf(value), value.field)}`,
        `SELECT ${rows.map(selectExpr).join(", ")}`,
        from,
        where,
        groupBy,
        orderBy,
        `PIVOT ${colRef(column)}`,
      );
    }
    default: {
      const shown = used.filter((c) => c.show && !(totals && totalOf(c) === "Where"));
      const select = `SELECT ${distinct}${shown.length ? shown.map(selectExpr).join(", ") : "*"}`;
      const into = type === "makeTable" ? `INTO ${br(design.target ?? "")}` : "";
      return lines(select, into, from, where, groupBy, having, orderBy);
    }
  }
}

/** Builds Access SQL for a select query from the design grid (kept for simple callers). */
export function designToSql(doc: ProjectDoc, tables: string[], columns: QueryColumn[]): string {
  return designSql(doc, { tables, columns });
}
