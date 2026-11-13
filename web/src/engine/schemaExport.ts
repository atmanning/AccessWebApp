/**
 * File → Export Schema: the design of chosen tables (fields, types, keys, indexes, defaults and
 * relationships) as SQL for another database, as a readable document, or as JSON.
 */
import type { Field, ProjectDoc, TableDef } from "../../../shared/model";

export const SCHEMA_FORMATS = ["mysql", "sqlite", "access", "markdown", "json"] as const;
export type SchemaFormat = (typeof SCHEMA_FORMATS)[number];

export const SCHEMA_FORMAT_LABELS: Record<SchemaFormat, string> = {
  mysql: "SQL – MySQL / MariaDB",
  sqlite: "SQL – SQLite",
  access: "SQL – Microsoft Access (DDL)",
  markdown: "Document (Markdown)",
  json: "JSON",
};

type SqlDialect = "mysql" | "sqlite" | "access";

export interface SchemaExport {
  text: string;
  extension: string;
  mime: string;
}

/** A relationship between two of the chosen tables, by name. */
interface Rel {
  name: string;
  parent: TableDef;
  parentField: Field;
  child: TableDef;
  childField: Field;
  enforce: boolean;
  cascadeUpdate: boolean;
  cascadeDelete: boolean;
}

export function exportSchema(doc: ProjectDoc, tableIds: string[], format: SchemaFormat, opts: { databaseName?: string } = {}): SchemaExport {
  const tables = doc.tables.filter((t) => tableIds.includes(t.id));
  const rels = relationsOf(doc, tables);
  switch (format) {
    case "json":
      return { text: jsonSchema(doc, tables, rels), extension: "json", mime: "application/json" };
    case "markdown":
      return { text: markdownSchema(doc, tables, rels, opts.databaseName), extension: "md", mime: "text/markdown" };
    default:
      return { text: sqlSchema(tables, rels, format, opts.databaseName), extension: "sql", mime: "application/sql" };
  }
}

function relationsOf(doc: ProjectDoc, tables: TableDef[]): Rel[] {
  const used = new Set<string>();
  const out: Rel[] = [];
  for (const r of doc.relationships) {
    const parent = tables.find((t) => t.id === r.fromTable);
    const child = tables.find((t) => t.id === r.toTable);
    const parentField = parent?.fields.find((f) => f.id === r.fromField);
    const childField = child?.fields.find((f) => f.id === r.toField);
    if (!parent || !child || !parentField || !childField) continue;
    let name = `fk_${child.name}_${childField.name}`.replace(/[^\w]+/g, "_").slice(0, 60);
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${name.replace(/_\d+$/, "")}_${n}`;
    used.add(name.toLowerCase());
    out.push({ name, parent, parentField, child, childField, enforce: r.enforce, cascadeUpdate: r.enforce && !!r.cascadeUpdate, cascadeDelete: r.enforce && !!r.cascadeDelete });
  }
  return out;
}

/** Parents before the tables that refer to them, where possible (cycles keep their order). */
function dependencyOrder(tables: TableDef[], rels: Rel[]): TableDef[] {
  const done: TableDef[] = [];
  const pending = [...tables];
  while (pending.length) {
    const i = pending.findIndex((t) => rels.every((r) => r.child !== t || r.parent === t || !r.enforce || done.includes(r.parent)));
    done.push(...pending.splice(i < 0 ? 0 : i, 1));
  }
  return done;
}

// ---- SQL ------------------------------------------------------------------------------------

function quoteName(name: string, d: SqlDialect) {
  if (d === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  if (d === "access") return `[${name}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

function sqlType(f: Field, d: SqlDialect): string {
  switch (f.type) {
    case "AutoNumber":
      return d === "mysql" ? "INT" : d === "access" ? "COUNTER" : "INTEGER";
    case "ShortText":
      return d === "sqlite" ? "TEXT" : d === "access" ? `TEXT(${f.size ?? 255})` : `VARCHAR(${f.size ?? 255})`;
    case "LongText":
      return d === "mysql" ? "LONGTEXT" : d === "access" ? "LONGTEXT" : "TEXT";
    case "Number": {
      const size = f.numberSize ?? "Long";
      if (d === "sqlite") return size === "Single" || size === "Double" ? "REAL" : "INTEGER";
      if (d === "access") return { Byte: "BYTE", Integer: "SHORT", Long: "LONG", Single: "SINGLE", Double: "DOUBLE" }[size];
      return { Byte: "TINYINT UNSIGNED", Integer: "SMALLINT", Long: "INT", Single: "FLOAT", Double: "DOUBLE" }[size];
    }
    case "Currency":
      return d === "mysql" ? "DECIMAL(19,4)" : d === "access" ? "CURRENCY" : "NUMERIC";
    case "DateTime":
      return d === "sqlite" ? "TEXT" : "DATETIME";
    case "YesNo":
      return d === "mysql" ? "TINYINT(1)" : d === "access" ? "YESNO" : "INTEGER";
    case "Image":
      return d === "mysql" ? "LONGBLOB" : d === "access" ? "LONGBINARY" : "BLOB";
  }
  return "TEXT";
}

/** A field's Default Value as SQL, or null when it can't be expressed (shown as a comment instead). */
function sqlDefault(f: Field, d: SqlDialect): string | null {
  const raw = f.defaultValue?.trim();
  if (!raw) return null;
  const v = raw.replace(/^=/, "").trim();
  if (/^(now|date)\(\)$/i.test(v)) {
    const date = /^date/i.test(v);
    if (d === "access") return date ? "Date()" : "Now()";
    if (d === "sqlite") return date ? "CURRENT_DATE" : "CURRENT_TIMESTAMP";
    return date ? "(CURRENT_DATE)" : "CURRENT_TIMESTAMP";
  }
  if (f.type === "YesNo") {
    const yes = /^(yes|true|-1|on)$/i.test(v);
    const no = /^(no|false|0|off)$/i.test(v);
    if (!yes && !no) return null;
    return d === "access" ? (yes ? "True" : "False") : yes ? "1" : "0";
  }
  if (f.type === "Number" || f.type === "Currency") return /^-?\d+(\.\d+)?$/.test(v) ? v : null;
  const text = v.replace(/^"(.*)"$/, "$1");
  return sqlString(text);
}

function sqlSchema(tables: TableDef[], rels: Rel[], d: SqlDialect, dbName?: string): string {
  const q = (n: string) => quoteName(n, d);
  const lines: string[] = [];
  const dialect = { mysql: "MySQL / MariaDB", sqlite: "SQLite", access: "Microsoft Access (Jet/ACE SQL)" }[d];
  lines.push(`-- Schema${dbName ? ` of ${dbName}` : ""}, exported from Access Web for ${dialect}`);
  lines.push(`-- ${tables.length} table(s), ${rels.filter((r) => r.enforce).length} foreign key(s). Data isn't included.`);
  if (d === "access") {
    lines.push("-- Run one statement at a time (Access runs a single statement per query). DEFAULT needs ANSI-92 SQL mode;");
    lines.push("-- remove those clauses if Access reports a syntax error.");
  }
  if (d === "mysql") lines.push("", "SET NAMES utf8mb4;");
  if (d === "sqlite") lines.push("", "PRAGMA foreign_keys = ON;");

  const ordered = dependencyOrder(tables, rels);
  const created = new Set<TableDef>();
  const later: Rel[] = [];
  for (const t of ordered) {
    const pk = t.fields.filter((f) => f.primaryKey);
    // SQLite's AUTOINCREMENT only works on a single INTEGER PRIMARY KEY column.
    const sqliteAutoPk = d === "sqlite" && pk.length === 1 && pk[0].type === "AutoNumber";
    const defs: string[] = [];
    for (const f of t.fields) {
      let def = `${q(f.name)} ${sqlType(f, d)}`;
      if (sqliteAutoPk && f.primaryKey) def += " PRIMARY KEY AUTOINCREMENT";
      const notNull = f.required || f.primaryKey || (d === "mysql" && f.type === "AutoNumber");
      // (SQLite's INTEGER PRIMARY KEY and Access's COUNTER are never null already.)
      if (notNull && !(sqliteAutoPk && f.primaryKey) && !(d === "access" && f.type === "AutoNumber")) def += " NOT NULL";
      if (f.type === "AutoNumber" && d === "mysql") def += " AUTO_INCREMENT";
      const dv = sqlDefault(f, d);
      if (dv) def += ` DEFAULT ${dv}`;
      if (d === "mysql" && f.description) def += ` COMMENT ${sqlString(f.description.slice(0, 1024))}`;
      const notes = [
        f.description && d !== "mysql" ? f.description : "",
        f.defaultValue && !dv ? `default ${f.defaultValue}` : "",
        f.lookup ? `lookup${f.lookup.displayColumn ? ` showing ${f.lookup.displayColumn}` : ""}` : "",
      ].filter(Boolean);
      defs.push(def + (notes.length ? `  -- ${notes.join("; ")}`.replace(/\n/g, " ") : ""));
    }
    // MySQL needs an AUTO_INCREMENT column to be a key.
    const autoNotKey = d === "mysql" ? t.fields.find((f) => f.type === "AutoNumber" && !f.primaryKey) : undefined;
    if (pk.length && !sqliteAutoPk) defs.push(`CONSTRAINT ${q(`pk_${t.name}`.replace(/[^\w]+/g, "_"))} PRIMARY KEY (${pk.map((f) => q(f.name)).join(", ")})`);
    if (autoNotKey) defs.push(`UNIQUE (${q(autoNotKey.name)})`);
    for (const r of rels.filter((x) => x.child === t && x.enforce)) {
      if (created.has(r.parent) || r.parent === t) defs.push(fkClause(r, q));
      else later.push(r);
    }
    // Comments trail each column, so commas go before them.
    const body = defs.map((x, i) => {
      const comma = i < defs.length - 1 ? "," : "";
      const at = x.indexOf("  -- ");
      return "  " + (at >= 0 ? x.slice(0, at) + comma + x.slice(at) : x + comma);
    });
    lines.push("", `CREATE TABLE ${q(t.name)} (`, ...body, `)${d === "mysql" ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4" : ""};`);
    for (const f of t.fields.filter((x) => x.indexed && x.indexed !== "No" && !x.primaryKey)) {
      const unique = f.indexed === "YesNoDup";
      if (autoNotKey === f && unique) continue;
      lines.push(`CREATE ${unique ? "UNIQUE " : ""}INDEX ${q(`ix_${t.name}_${f.name}`.replace(/[^\w]+/g, "_"))} ON ${q(t.name)} (${q(f.name)});`);
    }
    created.add(t);
  }
  if (later.length) {
    lines.push("");
    if (d === "sqlite") {
      lines.push("-- SQLite can't add foreign keys afterwards; these tables refer to each other:");
      for (const r of later) lines.push(`--   ${r.child.name}.${r.childField.name} → ${r.parent.name}.${r.parentField.name}`);
    } else for (const r of later) lines.push(`ALTER TABLE ${q(r.child.name)} ADD ${fkClause(r, q)};`);
  }
  const loose = rels.filter((r) => !r.enforce);
  if (loose.length) {
    lines.push("", "-- Relationships without referential integrity (not foreign keys):");
    for (const r of loose) lines.push(`--   ${r.child.name}.${r.childField.name} → ${r.parent.name}.${r.parentField.name}`);
  }
  return lines.join("\n") + "\n";
}

function fkClause(r: Rel, q: (n: string) => string) {
  return (
    `CONSTRAINT ${q(r.name)} FOREIGN KEY (${q(r.childField.name)}) REFERENCES ${q(r.parent.name)} (${q(r.parentField.name)})` +
    (r.cascadeUpdate ? " ON UPDATE CASCADE" : "") +
    (r.cascadeDelete ? " ON DELETE CASCADE" : "")
  );
}

// ---- Document and JSON ------------------------------------------------------------------------

const TYPE_TEXT: Record<Field["type"], string> = {
  AutoNumber: "AutoNumber",
  ShortText: "Short Text",
  LongText: "Long Text",
  Number: "Number",
  Currency: "Currency",
  DateTime: "Date/Time",
  YesNo: "Yes/No",
  Image: "Image",
};

function typeText(f: Field) {
  if (f.type === "ShortText") return `Short Text (${f.size ?? 255})`;
  if (f.type === "Number") return `Number (${f.numberSize === "Long" || !f.numberSize ? "Long Integer" : f.numberSize})`;
  return TYPE_TEXT[f.type];
}

function lookupText(doc: ProjectDoc, f: Field) {
  const l = f.lookup;
  if (!l) return "";
  if (l.rowSourceType === "values") return `Value list: ${l.rowSource}`;
  const src = l.rowSourceType === "table" ? doc.tables.find((t) => t.id === l.rowSource)?.name : doc.queries.find((q) => q.id === l.rowSource)?.name;
  return `${src ?? "?"}: stores ${l.boundColumn ?? "first field"}, shows ${l.displayColumn ?? "second field"}`;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function markdownSchema(doc: ProjectDoc, tables: TableDef[], rels: Rel[], dbName?: string): string {
  const out: string[] = [`# ${dbName ? `${dbName}: ` : ""}table design`, "", `Exported from Access Web on ${new Date().toLocaleDateString()}. ${tables.length} table(s).`];
  for (const t of tables) {
    out.push("", `## ${t.name}`, "", `${t.rows.length.toLocaleString()} record(s).`, "");
    out.push("| Field | Data type | Key | Required | Indexed | Default | Lookup | Description |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const f of t.fields) {
      out.push(
        `| ${cell(f.name)} | ${typeText(f)} | ${f.primaryKey ? "PK" : ""} | ${f.required || f.primaryKey ? "Yes" : ""} | ${f.primaryKey ? "Unique" : f.indexed === "YesNoDup" ? "Unique" : f.indexed === "YesDup" ? "Yes" : ""} | ${cell(f.defaultValue ?? "")} | ${cell(lookupText(doc, f))} | ${cell(f.description ?? "")} |`,
      );
    }
    const mine = rels.filter((r) => r.child === t || r.parent === t);
    if (mine.length) {
      out.push("", "Relationships:", "");
      for (const r of mine) {
        out.push(`- ${r.parent.name}.${r.parentField.name} (one) → ${r.child.name}.${r.childField.name} (many)${r.enforce ? ", referential integrity enforced" : ""}${r.cascadeUpdate ? ", cascade updates" : ""}${r.cascadeDelete ? ", cascade deletes" : ""}`);
      }
    }
  }
  return out.join("\n") + "\n";
}

function jsonSchema(doc: ProjectDoc, tables: TableDef[], rels: Rel[]): string {
  const data = {
    exportedFrom: "Access Web",
    tables: tables.map((t) => ({
      name: t.name,
      records: t.rows.length,
      primaryKey: t.fields.filter((f) => f.primaryKey).map((f) => f.name),
      fields: t.fields.map((f) => ({
        name: f.name,
        type: f.type,
        ...(f.size !== undefined && f.type === "ShortText" ? { size: f.size } : {}),
        ...(f.type === "Number" ? { numberSize: f.numberSize ?? "Long" } : {}),
        required: !!(f.required || f.primaryKey),
        indexed: f.primaryKey ? "YesNoDup" : (f.indexed ?? "No"),
        ...(f.defaultValue ? { defaultValue: f.defaultValue } : {}),
        ...(f.description ? { description: f.description } : {}),
        ...(f.lookup ? { lookup: lookupText(doc, f) } : {}),
      })),
    })),
    relationships: rels.map((r) => ({ name: r.name, from: `${r.parent.name}.${r.parentField.name}`, to: `${r.child.name}.${r.childField.name}`, enforce: r.enforce, cascadeUpdate: r.cascadeUpdate, cascadeDelete: r.cascadeDelete })),
  };
  return JSON.stringify(data, null, 2) + "\n";
}
