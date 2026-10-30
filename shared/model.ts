/**
 * The project document: everything a user builds in one database lives here.
 * It is shared by the browser (editing, running queries) and the server
 * (validation, storage, export). Rows are keyed by field id, so renaming a
 * field never touches the data.
 */
import { z } from "zod";

export const FIELD_TYPES = ["AutoNumber", "ShortText", "LongText", "Number", "Currency", "DateTime", "YesNo"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  AutoNumber: "AutoNumber",
  ShortText: "Short Text",
  LongText: "Long Text",
  Number: "Number",
  Currency: "Currency",
  DateTime: "Date/Time",
  YesNo: "Yes/No",
};

export const NUMBER_SIZES = ["Byte", "Integer", "Long", "Single", "Double"] as const;
export const INDEX_OPTIONS = ["No", "YesDup", "YesNoDup"] as const;
export const INDEX_LABELS: Record<(typeof INDEX_OPTIONS)[number], string> = {
  No: "No",
  YesDup: "Yes (Duplicates OK)",
  YesNoDup: "Yes (No Duplicates)",
};

/** Access object names: 1–64 chars, no . ! ` [ ] and no leading space. */
export const NAME_PATTERN = /^[^.!`[\]\s][^.!`[\]]{0,63}$/;
export const nameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(64, "Names can be at most 64 characters")
  .refine((s) => NAME_PATTERN.test(s), "Names can't contain . ! ` [ or ]");

const id = z.string().min(1).max(64);
export const cellValueSchema = z.union([z.string().max(1_000_000), z.number(), z.boolean(), z.null()]);
export type CellValue = z.infer<typeof cellValueSchema>;

export const fieldSchema = z.object({
  id,
  name: nameSchema,
  type: z.enum(FIELD_TYPES),
  size: z.number().int().min(1).max(255).optional(),
  numberSize: z.enum(NUMBER_SIZES).optional(),
  required: z.boolean().optional(),
  defaultValue: z.string().max(255).optional(),
  description: z.string().max(255).optional(),
  primaryKey: z.boolean().optional(),
  indexed: z.enum(INDEX_OPTIONS).optional(),
});
export type Field = z.infer<typeof fieldSchema>;

/** `_id` is a stable row identity used by the UI; other keys are field ids. */
export const rowSchema = z.record(z.string(), cellValueSchema);
export type Row = z.infer<typeof rowSchema>;

export const tableSchema = z.object({
  id,
  name: nameSchema,
  description: z.string().max(255).optional(),
  fields: z.array(fieldSchema).max(255),
  rows: z.array(rowSchema),
  nextAutoNumber: z.number().int().min(1),
  /** Saved datasheet column widths in pixels, by field id. */
  columnWidths: z.record(z.string(), z.number().int().min(20).max(2000)).optional(),
});
export type TableDef = z.infer<typeof tableSchema>;

export const queryColumnSchema = z.object({
  table: z.string(),
  field: z.string(),
  show: z.boolean(),
  sort: z.enum(["", "ASC", "DESC"]),
  criteria: z.string().max(1000),
  /** Column width in the design grid, in pixels. */
  width: z.number().int().min(40).max(1000).optional(),
});
export type QueryColumn = z.infer<typeof queryColumnSchema>;

export const querySchema = z.object({
  id,
  name: nameSchema,
  /** Which view the query was last edited in. Design view regenerates `sql`. */
  mode: z.enum(["design", "sql"]),
  sql: z.string().max(100_000),
  design: z
    .object({
      tables: z.array(z.string()).max(16),
      columns: z.array(queryColumnSchema).max(255),
    })
    .optional(),
  /** Saved datasheet column widths in pixels, by result column name. */
  columnWidths: z.record(z.string(), z.number().int().min(20).max(2000)).optional(),
});
export type QueryDef = z.infer<typeof querySchema>;

export const sourceSchema = z.object({ kind: z.enum(["table", "query"]), id });
export type SourceRef = z.infer<typeof sourceSchema>;

export const formSchema = z.object({
  id,
  name: nameSchema,
  title: z.string().max(200),
  source: sourceSchema,
  columns: z.array(z.string()).max(255),
});
export type FormDef = z.infer<typeof formSchema>;

export const reportSchema = z.object({
  id,
  name: nameSchema,
  title: z.string().max(200),
  source: sourceSchema,
  columns: z.array(z.string()).max(255),
  groupBy: z.string().optional(),
  sortBy: z.string().optional(),
});
export type ReportDef = z.infer<typeof reportSchema>;

export const relationshipSchema = z.object({
  id,
  fromTable: id,
  fromField: id,
  toTable: id,
  toField: id,
  enforce: z.boolean(),
});
export type Relationship = z.infer<typeof relationshipSchema>;

export const projectDocSchema = z.object({
  version: z.literal(1),
  tables: z.array(tableSchema).max(500),
  queries: z.array(querySchema).max(500),
  forms: z.array(formSchema).max(500),
  reports: z.array(reportSchema).max(500),
  relationships: z.array(relationshipSchema).max(1000),
});
export type ProjectDoc = z.infer<typeof projectDocSchema>;

export type ObjectKind = "table" | "query" | "form" | "report";

export function emptyProject(): ProjectDoc {
  return { version: 1, tables: [], queries: [], forms: [], reports: [], relationships: [] };
}

/** Field types that get a fixed size in Access (shown read-only in design view). */
export function defaultFieldProps(type: FieldType): Partial<Field> {
  switch (type) {
    case "ShortText":
      return { size: 255 };
    case "Number":
      return { numberSize: "Long" };
    default:
      return {};
  }
}

/** What the signed-in user may do with a database. */
export type ProjectRole = "owner" | "edit" | "view";
export type SharePermission = "view" | "edit";
export type LinkAccess = "none" | SharePermission;

/** Project summary as listed on the home screen. */
export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  tableCount: number;
  role: ProjectRole;
  ownerName: string;
  /** Name of whoever saved last, when it wasn't the owner. */
  updatedByName?: string;
}

export interface ShareEntry {
  userId: string;
  email: string;
  name: string;
  permission: SharePermission;
}

export interface ShareSettings {
  linkAccess: LinkAccess;
  shares: ShareEntry[];
}

export interface ProjectRecord extends ProjectSummary {
  doc: ProjectDoc;
}

export interface UserInfo {
  id: string;
  email: string;
  name: string;
}

/**
 * Checks things a schema can't: unique names, valid references, primary keys.
 * Returns human-readable problems; empty means valid.
 */
export function checkProjectIntegrity(doc: ProjectDoc): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const allObjects: { name: string; kind: string }[] = [
    ...doc.tables.map((t) => ({ name: t.name, kind: "table" })),
    ...doc.queries.map((q) => ({ name: q.name, kind: "query" })),
  ];
  for (const o of allObjects) {
    const k = o.name.toLowerCase();
    if (seen.has(k)) problems.push(`Two tables or queries are named "${o.name}"`);
    seen.add(k);
  }
  for (const t of doc.tables) {
    const names = new Set<string>();
    for (const f of t.fields) {
      const k = f.name.toLowerCase();
      if (names.has(k)) problems.push(`Table "${t.name}" has two fields named "${f.name}"`);
      names.add(k);
    }
    if (t.fields.filter((f) => f.type === "AutoNumber").length > 1) {
      problems.push(`Table "${t.name}" can only have one AutoNumber field`);
    }
  }
  for (const r of doc.relationships) {
    const from = doc.tables.find((t) => t.id === r.fromTable);
    const to = doc.tables.find((t) => t.id === r.toTable);
    if (!from?.fields.some((f) => f.id === r.fromField) || !to?.fields.some((f) => f.id === r.toField)) {
      problems.push("A relationship refers to a table or field that no longer exists");
    }
  }
  return problems;
}
