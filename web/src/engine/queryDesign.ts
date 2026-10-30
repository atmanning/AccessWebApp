import type { Field, ProjectDoc, QueryColumn } from "../../../shared/model";
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

/** Builds Access SQL from the query design grid. */
export function designToSql(doc: ProjectDoc, tables: string[], columns: QueryColumn[]): string {
  const used = columns.filter((c) => c.field);
  const fieldOf = (c: QueryColumn) => doc.tables.find((t) => t.name === c.table)?.fields.find((f) => f.name === c.field);
  const colRef = (c: QueryColumn) => (c.field === "*" ? `${br(c.table)}.*` : `${br(c.table)}.${br(c.field)}`);

  const select = used.filter((c) => c.show).map(colRef);
  const where = used
    .filter((c) => c.field !== "*")
    .map((c) => criteriaToSql(colRef(c), c.criteria, fieldOf(c)))
    .filter((x): x is string => !!x);
  const order = used.filter((c) => c.sort && c.field !== "*").map((c) => `${colRef(c)} ${c.sort}`);

  if (!tables.length) return "";
  const lines = [`SELECT ${select.length ? select.join(", ") : "*"}`, `FROM ${fromClause(doc, tables)}`];
  if (where.length) lines.push(`WHERE ${where.map((w) => (where.length > 1 ? `(${w})` : w)).join(" AND ")}`);
  if (order.length) lines.push(`ORDER BY ${order.join(", ")}`);
  return lines.join("\n") + ";";
}
