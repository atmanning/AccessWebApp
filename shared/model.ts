/**
 * The project document: everything a user builds in one database lives here.
 * It is shared by the browser (editing, running queries) and the server
 * (validation, storage, export). Rows are keyed by field id, so renaming a
 * field never touches the data.
 */
import { z } from "zod";

export const FIELD_TYPES = ["AutoNumber", "ShortText", "LongText", "Number", "Currency", "DateTime", "YesNo", "Image"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  AutoNumber: "AutoNumber",
  ShortText: "Short Text",
  LongText: "Long Text",
  Number: "Number",
  Currency: "Currency",
  DateTime: "Date/Time",
  YesNo: "Yes/No",
  Image: "Image",
};

/**
 * Pictures in Image fields are stored on the server, apart from the database document; a cell holds
 * the picture's id, like "img_" followed by 32 hex digits.
 */
export const IMAGE_ID = /^img_[0-9a-f]{32}$/;
export const IMAGE_ID_ANYWHERE = /img_[0-9a-f]{32}/g;
/** Picture formats an Image field accepts (no SVG: it can carry scripts). */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

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
  /**
   * Lookup (Table Design's Lookup tab, like Access): the field is picked from a list in datasheets
   * and forms, typically the key of a related table shown by a name. Uses the same row source
   * settings as a form combo box.
   */
  lookup: z
    .object({
      /** Display Control: Combo Box or List Box (no lookup = Text Box). */
      display: z.enum(["combo", "list"]),
      rowSourceType: z.enum(["table", "query", "values"]),
      /** Table or query id, or a value list ("Red;Green;Blue", one per line also works). */
      rowSource: z.string().max(4000),
      /** Field of the row source stored in this field (default: its first field). */
      boundColumn: z.string().max(64).optional(),
      /** Field shown in place of the stored value (default: the second field, else the bound one). */
      displayColumn: z.string().max(64).optional(),
      /** Only values in the list can be entered (default Yes). */
      limitToList: z.boolean().optional(),
    })
    .optional(),
});
export type Field = z.infer<typeof fieldSchema>;
export type FieldLookup = NonNullable<Field["lookup"]>;
/** Field types that can have a lookup. */
export const LOOKUP_TYPES: readonly FieldType[] = ["ShortText", "Number"];

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
  /** Saved datasheet row height in pixels (unset = standard height). */
  rowHeight: z.number().int().min(16).max(300).optional(),
  /** Indexes on more than one field (Access's Indexes window), e.g. PetType + Breed must be unique together. */
  indexes: z
    .array(
      z.object({
        id,
        name: nameSchema,
        fields: z.array(id).min(1).max(10),
        unique: z.boolean(),
      }),
    )
    .max(32)
    .optional(),
});
export type TableDef = z.infer<typeof tableSchema>;
export type TableIndex = NonNullable<TableDef["indexes"]>[number];

export const QUERY_TYPES = ["select", "makeTable", "append", "update", "delete", "crosstab"] as const;
export type QueryType = (typeof QUERY_TYPES)[number];
export const QUERY_TYPE_LABELS: Record<QueryType, string> = {
  select: "Select",
  makeTable: "Make Table",
  append: "Append",
  update: "Update",
  delete: "Delete",
  crosstab: "Crosstab",
};
/** Choices in the design grid's Total row, as Access names them. */
export const TOTAL_OPTIONS = ["Group By", "Sum", "Avg", "Min", "Max", "Count", "StDev", "Var", "First", "Last", "Expression", "Where"] as const;
export type TotalOption = (typeof TOTAL_OPTIONS)[number];

export const queryColumnSchema = z.object({
  table: z.string(),
  /** A field name, "*", or (with `expr`) an Access expression such as [Qty]*[Price]. */
  field: z.string().max(4000),
  /** `field` is an expression rather than a field of `table`. */
  expr: z.boolean().optional(),
  /** Output name, shown in the grid as Alias: Field (AS in SQL). */
  alias: z.string().max(64).optional(),
  show: z.boolean(),
  sort: z.enum(["", "ASC", "DESC"]),
  criteria: z.string().max(1000),
  /** The "or:" criteria rows below Criteria; each row is ANDed across columns, rows are ORed. */
  or: z.array(z.string().max(1000)).max(20).optional(),
  /** Column width in the design grid, in pixels. */
  width: z.number().int().min(40).max(1000).optional(),
  /** Total row (select queries with Totals on, and crosstabs). */
  total: z.enum(TOTAL_OPTIONS).optional(),
  /** Crosstab row. */
  crosstab: z.enum(["", "row", "column", "value"]).optional(),
  /** Append To row: the target table's field name. */
  appendTo: z.string().max(64).optional(),
  /** Update To row: an Access expression. */
  updateTo: z.string().max(1000).optional(),
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
      /** Query type chosen in Design View (defaults to select). */
      type: z.enum(QUERY_TYPES).optional(),
      /** Totals (Σ) on: shows the Total row for select, make-table and append queries. */
      totals: z.boolean().optional(),
      /** Make Table: the new table's name. Append: the table records are added to. */
      target: z.string().max(64).optional(),
      /** Where each table's field list sits in the upper pane, by table name (unset = in a row). */
      boxes: z
        .record(
          z.string(),
          z.object({
            x: z.number().int().min(0).max(10_000),
            y: z.number().int().min(0).max(10_000),
            w: z.number().int().min(100).max(800).optional(),
            /** Height of the field list (unset = fit the fields, up to a limit). */
            h: z.number().int().min(40).max(1200).optional(),
          }),
        )
        .optional(),
      /** Unique Values (SELECT DISTINCT). */
      distinct: z.boolean().optional(),
      /**
       * Joins drawn between the tables. Unset = worked out from relationships (designs made before
       * joins could be edited); set = exactly these, including outer joins.
       */
      joins: z
        .array(
          z.object({
            t1: z.string(),
            f1: z.string(),
            t2: z.string(),
            f2: z.string(),
            /** inner; left = all records from t1; right = all records from t2. */
            kind: z.enum(["inner", "left", "right"]),
          }),
        )
        .max(64)
        .optional(),
      /** Height of the design grid in pixels (unset = standard). */
      gridHeight: z.number().int().min(80).max(2000).optional(),
    })
    .optional(),
  /** Saved datasheet column widths in pixels, by result column name. */
  columnWidths: z.record(z.string(), z.number().int().min(20).max(2000)).optional(),
  /** Saved datasheet row height in pixels (unset = standard height). */
  rowHeight: z.number().int().min(16).max(300).optional(),
});
export type QueryDef = z.infer<typeof querySchema>;

export const sourceSchema = z.object({ kind: z.enum(["table", "query"]), id });
export type SourceRef = z.infer<typeof sourceSchema>;

/** Controls a form can hold, as the designer's toolbox offers them. */
export const FORM_CONTROL_TYPES = ["label", "textbox", "combobox", "listbox", "checkbox", "button", "image", "subform", "rectangle", "line"] as const;
export type FormControlType = (typeof FORM_CONTROL_TYPES)[number];
export const FORM_SECTIONS = ["header", "detail", "footer"] as const;
export type FormSection = (typeof FORM_SECTIONS)[number];
/** What a command button does when clicked. */
export const BUTTON_ACTIONS = [
  "none",
  "firstRecord",
  "previousRecord",
  "nextRecord",
  "lastRecord",
  "newRecord",
  "saveRecord",
  "deleteRecord",
  "openForm",
  "openReport",
  "closeForm",
] as const;
export type ButtonAction = (typeof BUTTON_ACTIONS)[number];
export const FORM_THEMES = ["office", "modern", "slate", "ocean", "forest", "sunset", "midnight"] as const;
export type FormTheme = (typeof FORM_THEMES)[number];

const px = (min: number, max: number) => z.number().int().min(min).max(max);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const formControlSchema = z.object({
  id,
  type: z.enum(FORM_CONTROL_TYPES),
  name: nameSchema,
  section: z.enum(FORM_SECTIONS),
  x: px(0, 4000),
  y: px(0, 4000),
  w: px(1, 4000),
  h: px(1, 4000),
  /** Control Source: the record source field it shows and edits, or an expression ("=[A] & [B]") it calculates. */
  field: z.string().max(4000).optional(),
  /** Subforms: the table whose records they show (Source Object), and the fields that link them to the form's record. */
  sourceObject: id.optional(),
  linkMaster: z.string().max(64).optional(),
  linkChild: z.string().max(64).optional(),
  /** False: Tab and Enter skip this control (you can still click it). */
  tabStop: z.boolean().optional(),
  /** How a calculated value is shown: Currency, Percent, Short Date, 0.00, mm/dd/yyyy… */
  format: z.string().max(100).optional(),
  /** Label, button and check box text. */
  caption: z.string().max(500).optional(),
  /** Built-in label of a bound control, and where it goes. */
  label: z.string().max(200).optional(),
  labelPos: z.enum(["top", "left", "none"]).optional(),
  labelWidth: px(20, 1000).optional(),
  placeholder: z.string().max(200).optional(),
  multiline: z.boolean().optional(),
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  fontSize: px(8, 72).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  color: hexColor.optional(),
  backColor: hexColor.optional(),
  borderColor: hexColor.optional(),
  borderWidth: px(0, 12).optional(),
  radius: px(0, 60).optional(),
  /** Combo and list boxes: a typed list ("A;B;C") or a table / query to look values up in. */
  rowSourceType: z.enum(["values", "table", "query"]).optional(),
  rowSource: z.string().max(4000).optional(),
  /** Column whose value is saved, and the column people see (table / query row sources). */
  boundColumn: z.string().max(64).optional(),
  displayColumn: z.string().max(64).optional(),
  /** Buttons: what they do, and which form or report they open. */
  action: z.enum(BUTTON_ACTIONS).optional(),
  target: id.optional(),
  /** Button look (primary/secondary/outline/danger), or "switch" for a check box drawn as a switch. */
  variant: z.enum(["primary", "secondary", "outline", "danger", "switch"]).optional(),
});
export type FormControl = z.infer<typeof formControlSchema>;

export const formLayoutSchema = z.object({
  width: px(160, 4000),
  sections: z.object({ header: px(0, 2000), detail: px(16, 4000), footer: px(0, 2000) }),
  theme: z.enum(FORM_THEMES),
  controls: z.array(formControlSchema).max(1000),
  /** Tab order: control ids in the order Tab moves through them, section by section. Controls not listed follow in reading order. */
  tabOrder: z.array(id).max(1000).optional(),
  /** Record navigation bar under the form (on unless false). */
  navigationButtons: z.boolean().optional(),
  allowEdits: z.boolean().optional(),
  allowAdditions: z.boolean().optional(),
  allowDeletions: z.boolean().optional(),
});
export type FormLayout = z.infer<typeof formLayoutSchema>;

export const formSchema = z.object({
  id,
  name: nameSchema,
  title: z.string().max(200),
  source: sourceSchema,
  /** Fields the form shows. With a layout, kept in step with its bound controls. */
  columns: z.array(z.string()).max(255),
  /** Designed layout. Forms made before the designer get one generated from `columns`. */
  layout: formLayoutSchema.optional(),
});
export type FormDef = z.infer<typeof formSchema>;

const inches = (min: number, max: number) => z.number().min(min).max(max);

/** One line of text on a label: a template such as "[FirstName] [LastName]". */
export const labelLineSchema = z.object({
  text: z.string().max(500),
  /** Font size in points. */
  size: z.number().min(5).max(96),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
});
export type LabelLine = z.infer<typeof labelLineSchema>;

/**
 * A labels report (Access's Label Wizard): one label per record on sheets of labels or name
 * badges. Sizes are in inches.
 */
export const labelLayoutSchema = z.object({
  /** Which sheet it was set up from, e.g. "avery-5395" (or "custom"). */
  preset: z.string().max(40).optional(),
  page: z.enum(["letter", "a4"]),
  width: inches(0.5, 11),
  height: inches(0.3, 14),
  across: z.number().int().min(1).max(10),
  down: z.number().int().min(1).max(40),
  marginTop: inches(0, 5),
  marginLeft: inches(0, 5),
  gapX: inches(0, 3),
  gapY: inches(0, 3),
  /** Space inside each label's edge. */
  padding: inches(0, 1),
  align: z.enum(["left", "center", "right"]),
  lines: z.array(labelLineSchema).max(10),
  /** Thin outline around each label (helps line up cutting or a test print). */
  outline: z.boolean().optional(),
  /** Labels already used on the first sheet, to print a partly used sheet. */
  skip: z.number().int().min(0).max(400).optional(),
  /** A QR code that opens the record in this database when scanned. */
  qr: z
    .object({
      /** What the code opens: a form (on the record), the table's datasheet, or a public report (no sign-in). */
      target: z.enum(["form", "table", "public"]),
      formId: z.string().max(64).optional(),
      /** For "public": the report (made public) the code opens, highlighting the person. */
      publicReportId: z.string().max(64).optional(),
      size: inches(0.4, 4),
      position: z.enum(["right", "left", "bottom"]),
      /** Address people scan to reach this app (default: the address it's open at). */
      baseUrl: z.string().max(300).optional(),
    })
    .optional(),
});
export type LabelLayout = z.infer<typeof labelLayoutSchema>;

export const reportSchema = z.object({
  id,
  name: nameSchema,
  title: z.string().max(200),
  source: sourceSchema,
  columns: z.array(z.string()).max(255),
  groupBy: z.string().optional(),
  sortBy: z.string().optional(),
  /** Set for a labels report (name tags, address labels) instead of a list. */
  labels: labelLayoutSchema.optional(),
});
export type ReportDef = z.infer<typeof reportSchema>;

export const relationshipSchema = z.object({
  id,
  fromTable: id,
  fromField: id,
  toTable: id,
  toField: id,
  enforce: z.boolean(),
  /** With referential integrity: changing the key changes it in the related records (Cascade Update Related Fields). */
  cascadeUpdate: z.boolean().optional(),
  /** With referential integrity: deleting a record deletes its related records (Cascade Delete Related Records). */
  cascadeDelete: z.boolean().optional(),
});
export type Relationship = z.infer<typeof relationshipSchema>;

/**
 * A linked table, shown in the Tables group: either a table in an external MySQL database (browsed
 * through its connection) or a table or query in another database in this app that you can open
 * (yours, or shared with you).
 */
export const linkedTableSchema = z.object({
  id,
  name: nameSchema,
  /** MySQL link. */
  connectionId: id.optional(),
  remoteTable: z.string().min(1).max(64).optional(),
  /** Link to another database here: its id, the object's kind and id, and names for messages. */
  sourceProject: id.optional(),
  sourceKind: z.enum(["table", "query"]).optional(),
  sourceId: id.optional(),
  sourceName: z.string().max(64).optional(),
  sourceProjectName: z.string().max(200).optional(),
  /**
   * MySQL link: the table's foreign keys, read from the server when it was linked, so Query Design
   * can join linked tables and the Relationships window can show them. Unset = not read yet.
   */
  foreignKeys: z
    .array(
      z.object({
        name: z.string().max(64),
        /** The referenced (parent) table on the MySQL server. */
        refTable: z.string().max(64),
        columns: z.array(z.object({ field: z.string().max(64), refField: z.string().max(64) })).min(1).max(16),
      }),
    )
    .max(64)
    .optional(),
});
export type LinkedTable = z.infer<typeof linkedTableSchema>;

/** True when a link points at another database in this app rather than MySQL. */
export const isAppLink = (l: LinkedTable): l is LinkedTable & { sourceProject: string; sourceKind: "table" | "query"; sourceId: string } =>
  !!l.sourceProject && !!l.sourceKind && !!l.sourceId;

export const projectDocSchema = z.object({
  version: z.literal(1),
  tables: z.array(tableSchema).max(500),
  queries: z.array(querySchema).max(500),
  forms: z.array(formSchema).max(500),
  reports: z.array(reportSchema).max(500),
  relationships: z.array(relationshipSchema).max(1000),
  linkedTables: z.array(linkedTableSchema).max(500).optional(),
  /** What scanning a name tag's QR code does at a scan station (Home → Scan Tags). */
  scanActions: z
    .array(
      z.object({
        id,
        name: z.string().min(1).max(100),
        /** The table of people the tags belong to (its primary key is in each tag's code). */
        people: id,
        /** "add": a record in `table` (an attendance log, achievements earned); "set": a field on the person. */
        kind: z.enum(["add", "set"]),
        table: id.optional(),
        /** add: the field that stores the person's key. */
        personField: id.optional(),
        /** add: a Date/Time field filled with the time of the scan. */
        timeField: id.optional(),
        /** add: other fields filled with fixed values (e.g. Session = "Session 2"), as typed. */
        values: z.record(z.string(), z.string().max(255)).optional(),
        /** set: the person's field and the value it gets ("Yes", a word, or Now). */
        field: id.optional(),
        value: z.string().max(255).optional(),
        /** Don't record the same person twice. */
        once: z.boolean().optional(),
      }),
    )
    .max(100)
    .optional(),
  /** Where each table (or linked table) sits in the Relationships window, by its id. */
  relationshipLayout: z
    .record(z.string(), z.object({ x: z.number().int().min(0).max(20_000), y: z.number().int().min(0).max(20_000) }))
    .optional(),
});
export type ProjectDoc = z.infer<typeof projectDocSchema>;
export type ScanAction = NonNullable<ProjectDoc["scanActions"]>[number];

export type ObjectKind = "table" | "query" | "form" | "report" | "linked";

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
  /** Anyone on the internet with the link can view it, without signing in (no export or copy). */
  publicView: boolean;
  shares: ShareEntry[];
}

export interface ProjectRecord extends ProjectSummary {
  doc: ProjectDoc;
  /** Opened through its public link: view only, and exporting, copying and linking are off. */
  publicView?: boolean;
}

/** Which build of the app is running, shown in the title bar. */
export interface VersionInfo {
  /** Git commit the build came from, when known. */
  commit: string | null;
  builtAt: string | null;
  startedAt: string;
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
    ...(doc.linkedTables ?? []).map((t) => ({ name: t.name, kind: "linked table" })),
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

// ---- External MySQL connections ---------------------------------------------------------

export const SSL_MODES = ["off", "required", "verify"] as const;
export type SslMode = (typeof SSL_MODES)[number];
export const SSL_LABELS: Record<SslMode, string> = {
  off: "Off",
  required: "Required (encrypt, don't check certificate)",
  verify: "Required, verify certificate",
};

export const connectionInputSchema = z.object({
  name: z.string().trim().min(1, "Give the connection a name").max(64),
  host: z.string().trim().min(1, "Enter the server address").max(255),
  port: z.number().int().min(1).max(65535),
  database: z.string().trim().max(64),
  user: z.string().trim().min(1, "Enter the user name").max(80),
  /** Omitted when editing means "keep the saved password". */
  password: z.string().max(500).optional(),
  ssl: z.enum(SSL_MODES),
});
export type ConnectionInput = z.infer<typeof connectionInputSchema>;

/** A saved connection as the browser sees it: never includes the password. */
export interface ConnectionInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: SslMode;
  hasPassword: boolean;
}

/** A foreign key on a MySQL server: child table columns that reference a parent table. */
export interface RemoteForeignKey {
  name: string;
  table: string;
  refTable: string;
  columns: { field: string; refField: string }[];
}

export interface RemoteTableInfo {
  name: string;
  type: "table" | "view";
  rows: number | null;
}

/** Result of running SQL on a MySQL connection, shaped like the mysql command-line client's output. */
export type SqlRunResult =
  | { kind: "rows"; columns: string[]; fields: (Field | null)[]; rows: CellValue[][]; truncated: boolean; elapsedMs: number }
  | { kind: "ok"; affectedRows: number; changedRows?: number; insertId?: number; info: string; warnings: number; elapsedMs: number }
  | { kind: "error"; errno: number | null; sqlState: string | null; code: string | null; message: string; elapsedMs: number };

/** Rows of a linked table, for browsing. */
export interface RemoteRows {
  columns: string[];
  fields: (Field | null)[];
  rows: CellValue[][];
  total: number | null;
  offset: number;
  skipped: string[];
}
