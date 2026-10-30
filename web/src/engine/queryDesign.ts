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

function fromClause(doc: ProjectDoc, tableNames: string[]): string {
  if (!tableNames.length) return "";
  const byName = (n: string) => doc.tables.find((t) => t.name === n);
  let sql = br(tableNames[0]);
  const joined = new Set([tableNames[0]]);
  const unjoined: string[] = [];
  let joins = 0;
  for (const name of tableNames.slice(1)) {
    const t = byName(name);
    const rel = t
      ? doc.relationships.find((r) => {
          const other = r.fromTable === t.id ? r.toTable : r.toTable === t.id ? r.fromTable : null;
          const otherT = doc.tables.find((x) => x.id === other);
          return otherT && joined.has(otherT.name);
        })
      : undefined;
    if (!t || !rel) {
      unjoined.push(name);
      continue;
    }
    const from = doc.tables.find((x) => x.id === rel.fromTable)!;
    const to = doc.tables.find((x) => x.id === rel.toTable)!;
    const ff = from.fields.find((f) => f.id === rel.fromField)!;
    const tf = to.fields.find((f) => f.id === rel.toField)!;
    if (joins > 0) sql = `(${sql})`;
    sql += ` INNER JOIN ${br(name)} ON ${br(from.name)}.${br(ff.name)} = ${br(to.name)}.${br(tf.name)}`;
    joined.add(name);
    joins++;
  }
  return [sql, ...unjoined.map(br)].join(", ");
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
  const fieldOf = (c: QueryColumn) => doc.tables.find((t) => t.name === c.table)?.fields.find((f) => f.name === c.field);
  const colRef = (c: QueryColumn) => (c.field === "*" ? `${br(c.table)}.*` : `${br(c.table)}.${br(c.field)}`);
  const totals = type === "crosstab" || (design.totals && (type === "select" || type === "makeTable" || type === "append"));
  const totalOf = (c: QueryColumn): TotalOption => (totals ? (c.total ?? "Group By") : "Group By");
  const isAgg = (c: QueryColumn) => totals && !["Group By", "Where"].includes(totalOf(c));
  /** The column as it appears in SELECT: plain, or wrapped in its total. */
  const selectExpr = (c: QueryColumn) => {
    if (!isAgg(c)) return colRef(c);
    const t = totalOf(c);
    const arg = c.field === "*" ? "*" : colRef(c);
    return `${t}(${arg}) AS ${aggAlias(t, c.field)}`;
  };
  const aggExpr = (c: QueryColumn) => `${totalOf(c)}(${c.field === "*" ? "*" : colRef(c)})`;

  const whereParts: string[] = [];
  const havingParts: string[] = [];
  for (const c of used) {
    if (c.field === "*") continue;
    if (isAgg(c)) {
      const h = criteriaToSql(aggExpr(c), c.criteria, fieldOf(c));
      if (h) havingParts.push(h);
    } else {
      const w = criteriaToSql(colRef(c), c.criteria, fieldOf(c));
      if (w) whereParts.push(w);
    }
  }
  const join = (parts: string[]) => parts.map((w) => (parts.length > 1 ? `(${w})` : w)).join(" AND ");
  const from = `FROM ${fromClause(doc, tables)}`;
  const where = whereParts.length ? `WHERE ${join(whereParts)}` : "";
  const order = used
    .filter((c) => c.sort && c.field !== "*" && !(type === "crosstab" && c.crosstab === "column"))
    .map((c) => `${isAgg(c) ? aggExpr(c) : colRef(c)} ${c.sort}`);
  const orderBy = order.length ? `ORDER BY ${order.join(", ")}` : "";
  // A crosstab's column heading goes in PIVOT, not GROUP BY.
  const groupCols = used.filter((c) => totals && totalOf(c) === "Group By" && c.field !== "*" && !(type === "crosstab" && c.crosstab === "column"));
  const groupBy = totals && groupCols.length ? `GROUP BY ${groupCols.map(colRef).join(", ")}` : "";
  const having = havingParts.length ? `HAVING ${join(havingParts)}` : "";
  const lines = (...parts: string[]) => parts.filter(Boolean).join("\n") + ";";

  switch (type) {
    case "update": {
      const sets = used.filter((c) => c.updateTo?.trim() && c.field !== "*").map((c) => `${colRef(c)} = ${c.updateTo!.trim()}`);
      return lines(`UPDATE ${fromClause(doc, tables)}`, `SET ${sets.join(", ")}`, where);
    }
    case "delete": {
      const star = used.find((c) => c.field === "*");
      return lines(`DELETE ${br(star?.table ?? tables[0])}.*`, from, where);
    }
    case "append": {
      const cols = used.filter((c) => c.appendTo);
      return lines(
        `INSERT INTO ${br(design.target ?? "")} (${cols.map((c) => br(c.appendTo!)).join(", ")})`,
        `SELECT ${cols.map(selectExpr).join(", ")}`,
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
        `TRANSFORM ${aggExpr(value)} AS ${aggAlias(totalOf(value), value.field)}`,
        `SELECT ${rows.map(colRef).join(", ")}`,
        from,
        where,
        groupBy,
        orderBy,
        `PIVOT ${colRef(column)}`,
      );
    }
    default: {
      const shown = used.filter((c) => c.show && !(totals && totalOf(c) === "Where"));
      const select = `SELECT ${shown.length ? shown.map(selectExpr).join(", ") : "*"}`;
      const into = type === "makeTable" ? `INTO ${br(design.target ?? "")}` : "";
      return lines(select, into, from, where, groupBy, having, orderBy);
    }
  }
}

/** Builds Access SQL for a select query from the design grid (kept for simple callers). */
export function designToSql(doc: ProjectDoc, tables: string[], columns: QueryColumn[]): string {
  return designSql(doc, { tables, columns });
}
