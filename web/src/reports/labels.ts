/**
 * Labels reports (name tags, address labels): sheet presets, filling in "[Field]" templates, and
 * the link a label's QR code opens.
 */
import type { CellValue, Field, LabelLayout, ProjectDoc, SourceRef } from "../../../shared/model";
import { formatValue } from "../engine/values";

export interface LabelPreset {
  id: string;
  name: string;
  layout: Pick<LabelLayout, "page" | "width" | "height" | "across" | "down" | "marginTop" | "marginLeft" | "gapX" | "gapY">;
}

/** Common Avery sheets (US Letter; other brands list the Avery number they match). */
export const LABEL_PRESETS: LabelPreset[] = [
  { id: "avery-5395", name: "Avery 5395 / 8395 – name badges, 2⅓″ × 3⅜″, 8 per sheet", layout: { page: "letter", width: 3.375, height: 2.333, across: 2, down: 4, marginTop: 0.583, marginLeft: 0.6875, gapX: 0.375, gapY: 0.167 } },
  { id: "avery-8371", name: "Avery 8371 / 5371 / 5911 / 8869 – business cards (pre-scored cardstock), 2″ × 3½″, 10 per sheet", layout: { page: "letter", width: 3.5, height: 2, across: 2, down: 5, marginTop: 0.5, marginLeft: 0.75, gapX: 0, gapY: 0 } },
  { id: "avery-5392", name: "Avery 5392 – badge inserts, 3″ × 4″, 6 per sheet", layout: { page: "letter", width: 4, height: 3, across: 2, down: 3, marginTop: 1, marginLeft: 0.25, gapX: 0, gapY: 0 } },
  { id: "avery-5390", name: "Avery 5390 – badge inserts, 2¼″ × 3½″, 8 per sheet", layout: { page: "letter", width: 3.5, height: 2.25, across: 2, down: 4, marginTop: 1, marginLeft: 0.75, gapX: 0, gapY: 0 } },
  { id: "avery-5164", name: "Avery 5164 – shipping labels, 3⅓″ × 4″, 6 per sheet", layout: { page: "letter", width: 4, height: 3.333, across: 2, down: 3, marginTop: 0.5, marginLeft: 0.156, gapX: 0.188, gapY: 0 } },
  { id: "avery-5163", name: "Avery 5163 – shipping labels, 2″ × 4″, 10 per sheet", layout: { page: "letter", width: 4, height: 2, across: 2, down: 5, marginTop: 0.5, marginLeft: 0.156, gapX: 0.188, gapY: 0 } },
  { id: "avery-5160", name: "Avery 5160 – address labels, 1″ × 2⅝″, 30 per sheet", layout: { page: "letter", width: 2.625, height: 1, across: 3, down: 10, marginTop: 0.5, marginLeft: 0.1875, gapX: 0.125, gapY: 0 } },
];

export const PAGE_SIZES: Record<LabelLayout["page"], { w: number; h: number; css: string; label: string }> = {
  letter: { w: 8.5, h: 11, css: "letter", label: "Letter (8½″ × 11″)" },
  a4: { w: 8.27, h: 11.69, css: "A4", label: "A4 (210 × 297 mm)" },
};

/** Problems with a layout, e.g. labels running off the page. */
export function layoutProblem(l: LabelLayout): string | null {
  const page = PAGE_SIZES[l.page];
  const right = l.marginLeft + l.across * l.width + (l.across - 1) * l.gapX;
  const bottom = l.marginTop + l.down * l.height + (l.down - 1) * l.gapY;
  if (right > page.w + 0.01) return `The labels are ${right.toFixed(2)}″ wide in all, wider than the ${page.w}″ page.`;
  if (bottom > page.h + 0.01) return `The labels are ${bottom.toFixed(2)}″ tall in all, taller than the ${page.h}″ page.`;
  return null;
}

/** Fills "[FirstName] [LastName]" from a record. Unknown names show as #Name?, like Access. */
export function fillTemplate(text: string, columns: string[], fields: (Field | undefined)[], row: CellValue[]): string {
  return text.replace(/\[([^\]]+)\]/g, (_, name: string) => {
    const i = columns.findIndex((c) => c.toLowerCase() === name.trim().toLowerCase());
    if (i < 0) return "#Name?";
    if (fields[i]?.type === "Image") return "";
    return formatValue(fields[i], row[i]);
  });
}

/** The field that identifies a record in links: the table's single-field primary key. */
export function linkKeyField(doc: ProjectDoc, source: SourceRef, target?: { kind: "form" | "table" | "public"; formId?: string }): string | null {
  let tableId = source.kind === "table" ? source.id : null;
  if (target?.kind === "form") {
    const f = doc.forms.find((x) => x.id === target.formId);
    if (f?.source.kind === "table") tableId = f.source.id;
  }
  const t = doc.tables.find((x) => x.id === tableId) ?? (source.kind === "query" ? null : undefined);
  const keys = t?.fields.filter((f) => f.primaryKey) ?? [];
  return keys.length === 1 ? keys[0].name : null;
}

/**
 * The address a QR code opens: this database, the chosen form (or the table), at the record whose
 * key field has this value. Scanning it needs someone signed in with access (or a public link).
 */
export function recordLink(base: string, projectId: string, open: { kind: "form" | "table"; id: string }, key: string, value: CellValue): string {
  const q = new URLSearchParams({ db: projectId, open: `${open.kind}:${open.id}`, key, rec: String(value ?? "") });
  return `${base.replace(/\/+$/, "")}/?${q.toString()}`;
}

/**
 * The address a QR code opens for a public report: anyone can open it without signing in. It carries
 * the person's key, so the page can highlight them and a scan station can tell who was scanned.
 */
export function publicRecordLink(base: string, token: string, key: string, value: CellValue): string {
  const q = new URLSearchParams({ key, rec: String(value ?? "") });
  return `${base.replace(/\/+$/, "")}/r/${token}?${q.toString()}`;
}

/** A starting layout for a source: name on line 1, something useful on line 2, a QR code. */
export function defaultLabels(doc: ProjectDoc, source: SourceRef, columns: string[], presetId = "avery-5395", qr = true): LabelLayout {
  const preset = LABEL_PRESETS.find((p) => p.id === presetId) ?? LABEL_PRESETS[0];
  const has = (n: string) => columns.find((c) => c.toLowerCase() === n.toLowerCase());
  const first = has("FirstName") ?? has("First Name") ?? has("GivenName");
  const last = has("LastName") ?? has("Last Name") ?? has("Surname");
  const name = has("Name") ?? has("FullName") ?? has("Full Name");
  const textCols = columns.filter((c) => !/id$/i.test(c));
  const line1 = first && last ? `[${first}] [${last}]` : name ? `[${name}]` : textCols[0] ? `[${textCols[0]}]` : "Hello";
  const second = ["Company", "Organization", "Organisation", "School", "Department", "Title", "Role", "City"].map(has).find(Boolean);
  const badge = preset.layout.height >= 2;
  const lines = [{ text: line1, size: badge ? 24 : 11, bold: true }, ...(second ? [{ text: `[${second}]`, size: badge ? 14 : 9 }] : [])];
  const form = source.kind === "table" ? doc.forms.find((f) => f.source.kind === "table" && f.source.id === source.id) : undefined;
  return {
    preset: preset.id,
    ...preset.layout,
    padding: badge ? 0.15 : 0.06,
    align: badge ? "center" : "left",
    lines,
    ...(qr && badge ? { qr: { target: form ? "form" as const : "table" as const, ...(form ? { formId: form.id } : {}), size: Math.min(1.2, preset.layout.height - 0.5), position: "right" as const } } : {}),
  };
}
