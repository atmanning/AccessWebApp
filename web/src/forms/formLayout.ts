/**
 * Form layouts: themes, control defaults, and the automatic layout used for new forms (and for
 * forms made before the designer existed).
 */
import type {
  ButtonAction,
  Field,
  FormControl,
  FormControlType,
  FormDef,
  FormLayout,
  FormSection,
  FormTheme,
} from "../../../shared/model";
import { newId } from "../workspace/docOps";

export const GRID = 8;
export const snap = (v: number, on = true) => (on ? Math.round(v / GRID) * GRID : Math.round(v));

export interface ThemeTokens {
  label: string;
  accent: string;
  accentText: string;
  header: string;
  headerText: string;
  surface: string;
  canvas: string;
  text: string;
  muted: string;
  input: string;
  inputBorder: string;
  radius: number;
  font: string;
  shadow: boolean;
}

const SANS = "'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif";
export const THEMES: Record<FormTheme, ThemeTokens> = {
  office: { label: "Office", accent: "#a4373a", accentText: "#ffffff", header: "#a4373a", headerText: "#ffffff", surface: "#ffffff", canvas: "#f3f3f3", text: "#222222", muted: "#5c5c5c", input: "#ffffff", inputBorder: "#ababab", radius: 0, font: SANS, shadow: false },
  modern: { label: "Modern", accent: "#4f46e5", accentText: "#ffffff", header: "#ffffff", headerText: "#1e1b4b", surface: "#ffffff", canvas: "#eef0f7", text: "#1f2937", muted: "#6b7280", input: "#f9fafb", inputBorder: "#d1d5db", radius: 8, font: SANS, shadow: true },
  slate: { label: "Slate", accent: "#334155", accentText: "#ffffff", header: "#1e293b", headerText: "#f8fafc", surface: "#ffffff", canvas: "#e2e8f0", text: "#0f172a", muted: "#64748b", input: "#ffffff", inputBorder: "#cbd5e1", radius: 6, font: SANS, shadow: true },
  ocean: { label: "Ocean", accent: "#0369a1", accentText: "#ffffff", header: "#0284c7", headerText: "#ffffff", surface: "#ffffff", canvas: "#e0f2fe", text: "#0c4a6e", muted: "#47708a", input: "#f8fcff", inputBorder: "#9cc9e3", radius: 10, font: SANS, shadow: true },
  forest: { label: "Forest", accent: "#15803d", accentText: "#ffffff", header: "#166534", headerText: "#f0fdf4", surface: "#ffffff", canvas: "#ecf5ee", text: "#14301e", muted: "#4f6b58", input: "#fbfefc", inputBorder: "#a7cdb3", radius: 6, font: SANS, shadow: true },
  sunset: { label: "Sunset", accent: "#ea580c", accentText: "#ffffff", header: "#fff7ed", headerText: "#9a3412", surface: "#ffffff", canvas: "#fdf0e6", text: "#3b1d0e", muted: "#8a5a40", input: "#fffaf5", inputBorder: "#f3c3a0", radius: 12, font: SANS, shadow: true },
  midnight: { label: "Midnight", accent: "#818cf8", accentText: "#0b1020", header: "#111827", headerText: "#e5e7eb", surface: "#1f2937", canvas: "#0b1020", text: "#e5e7eb", muted: "#9ca3af", input: "#111827", inputBorder: "#374151", radius: 8, font: SANS, shadow: false },
};

/** CSS custom properties for a theme, set on the form's root element. */
export function themeStyle(theme: FormTheme): Record<string, string> {
  const t = THEMES[theme] ?? THEMES.modern;
  return {
    "--f-accent": t.accent,
    "--f-accent-text": t.accentText,
    "--f-header": t.header,
    "--f-header-text": t.headerText,
    "--f-surface": t.surface,
    "--f-canvas": t.canvas,
    "--f-text": t.text,
    "--f-muted": t.muted,
    "--f-input": t.input,
    "--f-input-border": t.inputBorder,
    "--f-radius": `${t.radius}px`,
    "--f-font": t.font,
    "--f-shadow": t.shadow ? "0 1px 2px rgba(15,23,42,.06), 0 8px 24px rgba(15,23,42,.08)" : "none",
  };
}

export const CONTROL_LABELS: Record<FormControlType, string> = {
  label: "Label",
  textbox: "Text Box",
  combobox: "Combo Box",
  listbox: "List Box",
  checkbox: "Check Box",
  button: "Button",
  image: "Image",
  subform: "Subform",
  rectangle: "Rectangle",
  line: "Line",
};

export const ACTION_LABELS: Record<ButtonAction, string> = {
  none: "(nothing)",
  firstRecord: "Go to first record",
  previousRecord: "Go to previous record",
  nextRecord: "Go to next record",
  lastRecord: "Go to last record",
  newRecord: "Add new record",
  saveRecord: "Save record",
  deleteRecord: "Delete record",
  openForm: "Open form",
  openReport: "Open report",
  closeForm: "Close form",
};

export const SECTION_LABELS: Record<FormSection, string> = { header: "Form Header", detail: "Detail", footer: "Form Footer" };

/** Controls that show and edit a field. */
export const isBound = (t: FormControlType) => t === "textbox" || t === "combobox" || t === "listbox" || t === "checkbox" || t === "image";
/** Bound controls drawn with their own label above or beside them. */
export const hasLabel = (t: FormControlType) => t === "textbox" || t === "combobox" || t === "listbox" || t === "image" || t === "subform";

const LABEL_H = 22;
const INPUT_H = 34;

/** Size of a new control of this type. */
export function defaultSize(type: FormControlType, opts: { labelPos?: "top" | "left" | "none"; multiline?: boolean } = {}) {
  const top = (opts.labelPos ?? "top") === "top";
  const lab = top ? LABEL_H : 0;
  switch (type) {
    case "label":
      return { w: 160, h: 24 };
    case "textbox":
      return { w: 280, h: lab + (opts.multiline ? 88 : INPUT_H) };
    case "combobox":
      return { w: 280, h: lab + INPUT_H };
    case "listbox":
      return { w: 220, h: lab + 112 };
    case "checkbox":
      return { w: 200, h: 28 };
    case "button":
      return { w: 120, h: 36 };
    case "image":
      return { w: 220, h: lab + 160 };
    case "subform":
      return { w: 560, h: lab + 200 };
    case "rectangle":
      return { w: 240, h: 120 };
    case "line":
      return { w: 240, h: 2 };
  }
}

/** A unique control name such as "Text3", like Access. */
export function nextControlName(layout: FormLayout, base: string) {
  const taken = new Set(layout.controls.map((c) => c.name.toLowerCase()));
  for (let i = 1; ; i++) {
    const n = `${base}${i}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

const BASE_NAMES: Record<FormControlType, string> = {
  label: "Label",
  textbox: "Text",
  combobox: "Combo",
  listbox: "List",
  checkbox: "Check",
  button: "Command",
  image: "Image",
  subform: "Child",
  rectangle: "Box",
  line: "Line",
};

/** Name for a control bound to a field: the field name, made unique and valid. */
function nameFor(layout: FormLayout, type: FormControlType, field?: string) {
  if (field) {
    const clean = field.replace(/[.!`[\]]/g, "_").slice(0, 60);
    const taken = new Set(layout.controls.map((c) => c.name.toLowerCase()));
    if (!taken.has(clean.toLowerCase())) return clean;
  }
  return nextControlName(layout, BASE_NAMES[type]);
}

/** The control Access would make for a field dropped on the form. */
export function controlTypeForField(field: Field | undefined): { type: FormControlType; multiline?: boolean } {
  // A lookup field becomes a combo (or list) box that picks from its row source, as in Access.
  if (field?.lookup) return { type: field.lookup.display === "list" ? "listbox" : "combobox" };
  if (field?.type === "YesNo") return { type: "checkbox" };
  if (field?.type === "Image") return { type: "image" };
  if (field?.type === "LongText") return { type: "textbox", multiline: true };
  return { type: "textbox" };
}

/** Makes a control (not yet added). Position is in section coordinates. */
export function makeControl(
  layout: FormLayout,
  type: FormControlType,
  at: { section: FormSection; x: number; y: number; w?: number; h?: number },
  opts: { field?: string; fieldDef?: Field; multiline?: boolean } = {},
): FormControl {
  const size = defaultSize(type, { multiline: opts.multiline });
  const c: FormControl = {
    id: newId("c"),
    type,
    name: nameFor(layout, type, opts.field),
    section: at.section,
    x: Math.max(0, at.x),
    y: Math.max(0, at.y),
    w: at.w ?? size.w,
    h: at.h ?? size.h,
  };
  if (opts.field) c.field = opts.field;
  if (hasLabel(type)) c.label = opts.field ?? c.name;
  if (type === "checkbox") c.caption = opts.field ?? c.name;
  if (opts.multiline) c.multiline = true;
  if (type === "label") c.caption = "Label";
  if (type === "button") {
    c.caption = "Button";
    c.action = "none";
    c.variant = "primary";
  }
  if (type === "combobox" || type === "listbox") {
    const lk = opts.fieldDef?.lookup;
    c.rowSourceType = lk?.rowSourceType ?? "values";
    c.rowSource = lk?.rowSource ?? "";
    if (lk?.boundColumn) c.boundColumn = lk.boundColumn;
    if (lk?.displayColumn) c.displayColumn = lk.displayColumn;
  }
  if (type === "rectangle") {
    c.borderWidth = 1;
    c.radius = THEMES[layout.theme]?.radius ?? 0;
  }
  if (opts.fieldDef?.type === "AutoNumber") c.locked = true;
  return c;
}

/** Bottom edge of the lowest control in a section. */
export function sectionContentBottom(layout: FormLayout, section: FormSection, except?: Set<string>) {
  return layout.controls.filter((c) => c.section === section && !except?.has(c.id)).reduce((m, c) => Math.max(m, c.y + c.h), 0);
}

export type LayoutStyle = "stacked" | "columns";

/**
 * Builds a complete layout from the record source's fields: a header with the title, the fields
 * (one column, or two when there are many), and a footer with the usual buttons.
 */
export function autoLayout(
  title: string,
  fields: { name: string; field?: Field }[],
  opts: { theme?: FormTheme; style?: LayoutStyle } = {},
): FormLayout {
  const theme = opts.theme ?? "modern";
  const style = opts.style ?? (fields.length > 6 ? "columns" : "stacked");
  const layout: FormLayout = {
    width: style === "columns" ? 688 : 432,
    sections: { header: 72, detail: 0, footer: 68 },
    theme,
    controls: [],
  };
  const pad = 24;
  const add = (c: FormControl) => layout.controls.push(c);

  const titleLabel = makeControl(layout, "label", { section: "header", x: pad, y: 18, w: layout.width - pad * 2, h: 36 });
  titleLabel.caption = title;
  titleLabel.name = "FormTitle";
  titleLabel.fontSize = 22;
  titleLabel.bold = theme !== "office";
  add(titleLabel);

  layoutFields(layout, fields, style);

  const buttons: [string, ButtonAction, "primary" | "secondary" | "outline" | "danger"][] = [
    ["◀ Previous", "previousRecord", "outline"],
    ["Next ▶", "nextRecord", "outline"],
    ["+ New", "newRecord", "primary"],
    ["Delete", "deleteRecord", "danger"],
  ];
  let x = pad;
  for (const [caption, action, variant] of buttons) {
    const b = makeControl(layout, "button", { section: "footer", x, y: 16, w: 112, h: 36 });
    b.caption = caption;
    b.action = action;
    b.variant = variant;
    add(b);
    x += 112 + 12;
  }
  layout.width = Math.max(layout.width, x + pad - 12);
  return layout;
}

/** Replaces the detail section with the fields laid out in one or two columns. */
export function layoutFields(layout: FormLayout, fields: { name: string; field?: Field }[], style: LayoutStyle) {
  const pad = 24;
  const gap = 24;
  const cols = style === "columns" ? 2 : 1;
  const colW = style === "columns" ? 308 : 384;
  layout.controls = layout.controls.filter((c) => c.section !== "detail");
  layout.width = Math.max(layout.width, pad * 2 + cols * colW + (cols - 1) * gap);
  const yAt = new Array(cols).fill(pad);
  // Long text goes full width at the end in two-column layouts, so the columns stay even.
  const wide = style === "columns" ? fields.filter((f) => f.field?.type === "LongText") : [];
  const narrow = fields.filter((f) => !wide.includes(f));
  narrow.forEach((f, i) => {
    const col = cols === 1 ? 0 : i % 2;
    const kind = controlTypeForField(f.field);
    const c = makeControl(layout, kind.type, { section: "detail", x: pad + col * (colW + gap), y: yAt[col] }, { field: f.name, fieldDef: f.field, multiline: kind.multiline });
    c.w = colW;
    if (kind.type === "checkbox") c.y += LABEL_H; // line up with the inputs beside it
    layout.controls.push(c);
    yAt[col] = c.y + c.h + 16;
  });
  let y = Math.max(...yAt);
  for (const f of wide) {
    const c = makeControl(layout, "textbox", { section: "detail", x: pad, y }, { field: f.name, fieldDef: f.field, multiline: true });
    c.w = cols * colW + gap;
    layout.controls.push(c);
    y = c.y + c.h + 16;
  }
  layout.sections.detail = Math.max(64, snap(Math.max(...yAt, y) + 8));
}

/** The form's layout, generated for forms that don't have one yet. */
export function layoutOf(form: FormDef, fields: { name: string; field?: Field }[]): FormLayout {
  if (form.layout) return form.layout;
  // A form made from a query starts with all of the query's fields.
  const names = form.columns.length ? form.columns : fields.map((f) => f.name);
  const shown = names.map((name) => ({ name, field: fields.find((f) => f.name.toLowerCase() === name.toLowerCase())?.field }));
  const generated = autoLayout(form.title || form.name, shown);
  // Stable ids, so a generated layout keeps its selection across redraws and undo.
  generated.controls.forEach((c, i) => (c.id = `${form.id}_c${i}`));
  return generated;
}

/** Keeps `columns` (used by renames and older code) in step with the bound controls. */
export function syncColumns(form: FormDef) {
  if (!form.layout) return;
  const seen = new Set<string>();
  form.columns = [];
  for (const c of form.layout.controls) {
    if (c.field && !c.field.startsWith("=") && !seen.has(c.field.toLowerCase())) {
      seen.add(c.field.toLowerCase());
      form.columns.push(c.field);
    }
  }
}

/** Controls in reading order (section, then top to bottom, left to right): tab order and phone layout. */
export function readingOrder(controls: FormControl[]) {
  const rank = { header: 0, detail: 1, footer: 2 } as const;
  return [...controls].sort((a, b) => rank[a.section] - rank[b.section] || a.y - b.y || a.x - b.x);
}

/** Controls you can Tab to (labels, lines and rectangles can't take the focus). */
export const takesFocus = (t: FormControlType) => t !== "label" && t !== "line" && t !== "rectangle";

/** One section's controls in tab order: the custom order first, then any others top to bottom, left to right. */
export function sectionTabOrder(layout: FormLayout, section: FormSection): FormControl[] {
  const here = layout.controls.filter((c) => c.section === section && takesFocus(c.type));
  const byId = new Map(here.map((c) => [c.id, c]));
  const listed = (layout.tabOrder ?? []).map((id) => byId.get(id)).filter((c): c is FormControl => !!c);
  const rest = readingOrder(here.filter((c) => !listed.includes(c)));
  return [...listed, ...rest];
}

/** All controls in the order Tab visits them (header, detail, footer), then the ones that can't take the focus. */
export function tabSequence(layout: FormLayout): FormControl[] {
  const sections: FormSection[] = ["header", "detail", "footer"];
  return [...sections.flatMap((s) => sectionTabOrder(layout, s)), ...readingOrder(layout.controls.filter((c) => !takesFocus(c.type)))];
}

/** Saves a section's tab order; drops the custom order altogether when every section is back to top-to-bottom. */
export function setSectionTabOrder(layout: FormLayout, section: FormSection, ids: string[]) {
  const sections: FormSection[] = ["header", "detail", "footer"];
  const next = sections.flatMap((s) => (s === section ? ids : sectionTabOrder(layout, s).map((c) => c.id)));
  const auto = sections.flatMap((s) => readingOrder(layout.controls.filter((c) => c.section === s && takesFocus(c.type))).map((c) => c.id));
  if (next.length === auto.length && next.every((id, i) => id === auto[i])) delete layout.tabOrder;
  else layout.tabOrder = next;
}

/** Choices of a typed value list: "A;B;C" or "\"A\";\"B\"". */
export function parseValueList(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(/;|\n/)
    .map((v) => v.trim().replace(/^"(.*)"$/, "$1"))
    .filter((v) => v !== "");
}
