/**
 * Designed reports: the order of their sections, paper sizes, and a starting layout made from a
 * report's fields like Access's Report Wizard (tabular: a title, column headings on each page, one
 * line per record, group headers, totals, page numbers).
 */
import type { Field, FormControlType, ReportControl, ReportDef, ReportLayout } from "../../../shared/model";
import { compileExpression, isExpression, namesUsed } from "../engine/expr";
import { newId } from "../workspace/docOps";

export const DPI = 96;

export interface SectionInfo {
  key: string;
  label: string;
  height: number;
  max: number;
  /** For group sections: the group level. */
  group?: ReportLayout["groups"][number];
  kind: "reportHeader" | "pageHeader" | "groupHeader" | "detail" | "groupFooter" | "pageFooter" | "reportFooter";
}

/** Every section in print order (group headers outermost first, footers innermost first). */
export function reportSections(l: ReportLayout): SectionInfo[] {
  const out: SectionInfo[] = [
    { key: "reportHeader", label: "Report Header", height: l.sections.reportHeader, max: 4000, kind: "reportHeader" },
    { key: "pageHeader", label: "Page Header", height: l.sections.pageHeader, max: 2000, kind: "pageHeader" },
  ];
  for (const g of l.groups) if (g.header > 0) out.push({ key: `gh:${g.id}`, label: `${g.field} Header`, height: g.header, max: 2000, group: g, kind: "groupHeader" });
  out.push({ key: "detail", label: "Detail", height: l.sections.detail, max: 4000, kind: "detail" });
  for (const g of [...l.groups].reverse()) if (g.footer > 0) out.push({ key: `gf:${g.id}`, label: `${g.field} Footer`, height: g.footer, max: 2000, group: g, kind: "groupFooter" });
  out.push({ key: "pageFooter", label: "Page Footer", height: l.sections.pageFooter, max: 2000, kind: "pageFooter" });
  out.push({ key: "reportFooter", label: "Report Footer", height: l.sections.reportFooter, max: 4000, kind: "reportFooter" });
  return out;
}

export function sectionHeight(l: ReportLayout, key: string): number {
  if (key.startsWith("gh:") || key.startsWith("gf:")) {
    const g = l.groups.find((x) => x.id === key.slice(3));
    return g ? (key.startsWith("gh:") ? g.header : g.footer) : 0;
  }
  return l.sections[key as keyof ReportLayout["sections"]] ?? 0;
}

export function setSectionHeight(l: ReportLayout, key: string, h: number) {
  if (key.startsWith("gh:") || key.startsWith("gf:")) {
    const g = l.groups.find((x) => x.id === key.slice(3));
    if (g) g[key.startsWith("gh:") ? "header" : "footer"] = h;
  } else l.sections[key as keyof ReportLayout["sections"]] = h;
}

export const PAGE_SIZE_INFO: Record<ReportLayout["page"]["size"], { label: string; w: number; h: number; css: string }> = {
  letter: { label: "Letter (8.5 × 11 in)", w: 8.5, h: 11, css: "letter" },
  legal: { label: "Legal (8.5 × 14 in)", w: 8.5, h: 14, css: "legal" },
  tabloid: { label: "Tabloid (11 × 17 in)", w: 11, h: 17, css: "11in 17in" },
  a4: { label: "A4 (210 × 297 mm)", w: 8.27, h: 11.69, css: "A4" },
  a5: { label: "A5 (148 × 210 mm)", w: 5.83, h: 8.27, css: "A5" },
  custom: { label: "Custom size", w: 8.5, h: 11, css: "" },
};

/** The page in inches (orientation applied) and its CSS @page size. */
export function pageSize(l: ReportLayout) {
  const info = PAGE_SIZE_INFO[l.page.size];
  let w = l.page.size === "custom" ? (l.page.width ?? 8.5) : info.w;
  let h = l.page.size === "custom" ? (l.page.height ?? 11) : info.h;
  if (l.page.landscape) [w, h] = [h, w];
  const m = l.page.margins;
  return { w, h, css: `${w}in ${h}in`, printableW: Math.max(0.5, w - m.left - m.right), printableH: Math.max(0.5, h - m.top - m.bottom) };
}

/** Fields a report uses (bound controls, expressions, grouping, sorting): what a public copy keeps. */
export function reportFieldsUsed(l: ReportLayout): string[] {
  const out = new Set<string>();
  for (const g of l.groups) out.add(g.field);
  for (const s of l.sorts) out.add(s.field);
  for (const c of l.controls) {
    if (!c.field) continue;
    if (!isExpression(c.field)) out.add(c.field);
    else {
      const compiled = compileExpression(c.field);
      if (compiled.ok) for (const n of namesUsed(compiled.node)) out.add(n);
    }
  }
  return [...out];
}

const isNumeric = (f?: Field) => f?.type === "Currency" || (f?.type === "Number" && !/id$/i.test(f.name));

/** A tabular layout for a report's fields, like Access's Report Wizard. */
export function wizardLayout(report: ReportDef, fields: { name: string; field?: Field }[]): ReportLayout {
  const page = { size: "letter" as const, margins: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 } };
  const width = Math.round((8.5 - 1) * DPI);
  const byName = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  const group = report.groupBy && byName.has(report.groupBy.toLowerCase()) ? byName.get(report.groupBy.toLowerCase())!.name : undefined;
  const cols = (report.columns.length ? report.columns : fields.map((f) => f.name)).filter((c) => byName.has(c.toLowerCase()) && c !== group);
  const groupId = newId("g");
  const controls: ReportControl[] = [];
  const names = new Set<string>();
  const name = (base: string) => {
    let n = base.replace(/[.![\]`]/g, "_").slice(0, 60) || "Control";
    for (let i = 2; names.has(n.toLowerCase()); i++) n = `${base.slice(0, 58)}${i}`;
    names.add(n.toLowerCase());
    return n;
  };
  const add = (c: Omit<ReportControl, "id" | "name"> & { name?: string }) => controls.push({ id: newId("c"), ...c, name: name(c.name ?? (c.field && !isExpression(c.field) ? c.field : c.type === "label" ? "Label" : "Text")) } as ReportControl);

  // Column widths: a share of the page by kind of field.
  const weight = (f?: Field) => (f?.type === "LongText" ? 3 : f?.type === "ShortText" ? 2 : f?.type === "Image" ? 1.5 : 1);
  const weights = cols.map((c) => weight(byName.get(c.toLowerCase())?.field));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let x = 0;
  const xs = weights.map((w) => {
    const at = x;
    x += Math.floor((width * w) / total);
    return at;
  });
  const wOf = (i: number) => (i === cols.length - 1 ? width - xs[i] : xs[i + 1] - xs[i]) - 6;
  const image = (c: string) => byName.get(c.toLowerCase())?.field?.type === "Image";
  const rowH = cols.some(image) ? 64 : 24;

  // Report header: the title and today's date.
  add({ type: "label", section: "reportHeader", x: 0, y: 8, w: width - 200, h: 40, caption: report.title || report.name, fontSize: 26, bold: true, name: "Title" });
  add({ type: "textbox", section: "reportHeader", x: width - 200, y: 18, w: 200, h: 22, field: "=Date()", format: "Long Date", align: "right", fontSize: 12, name: "PrintDate" });
  // Page header: column headings over a line.
  cols.forEach((c, i) => {
    const f = byName.get(c.toLowerCase())?.field;
    add({ type: "label", section: "pageHeader", x: xs[i], y: 6, w: wOf(i), h: 22, caption: c, bold: true, align: isNumeric(f) ? "right" : undefined, name: `${c}_Label` });
  });
  add({ type: "line", section: "pageHeader", x: 0, y: 32, w: width, h: 2, borderWidth: 2, name: "HeadingLine" });
  // Group header: the group's value.
  if (group) add({ type: "textbox", section: `gh:${groupId}`, x: 0, y: 6, w: Math.min(width, 400), h: 26, field: group, bold: true, fontSize: 16 });
  // Detail: one line per record.
  cols.forEach((c, i) => {
    const f = byName.get(c.toLowerCase())?.field;
    add({ type: f?.type === "YesNo" ? "checkbox" : image(c) ? "image" : "textbox", section: "detail", x: xs[i], y: 2, w: wOf(i), h: image(c) ? rowH - 4 : 22, field: c, align: isNumeric(f) ? "right" : undefined, ...(f?.type === "YesNo" ? { caption: "" } : {}) });
  });
  // Totals of number and currency fields in the group footer and report footer.
  const sums = cols.map((c, i) => ({ c, i, f: byName.get(c.toLowerCase())?.field })).filter((s) => isNumeric(s.f));
  const totals = (section: string, label: string, y: number) => {
    add({ type: "textbox", section, x: 0, y, w: Math.max(120, (xs[1] ?? width) - 6), h: 22, field: `="${label} (" & Count(*) & " " & IIf(Count(*)=1,"record","records") & ")"`, bold: true, name: `${label.replace(/\W/g, "")}Count` });
    for (const s of sums) add({ type: "textbox", section, x: xs[s.i], y, w: wOf(s.i), h: 22, field: `=Sum([${s.c}])`, format: s.f?.type === "Currency" ? "Currency" : undefined, align: "right", bold: true, name: `${label.replace(/\W/g, "")}_${s.c}` });
  };
  if (group) {
    add({ type: "line", section: `gf:${groupId}`, x: 0, y: 2, w: width, h: 1, borderWidth: 1, borderColor: "#999999", name: "GroupLine" });
    totals(`gf:${groupId}`, `Summary for ${group}`, 6);
  }
  add({ type: "line", section: "reportFooter", x: 0, y: 4, w: width, h: 2, borderWidth: 2, name: "TotalLine" });
  totals("reportFooter", "Grand Total", 10);
  // Page footer: when it was printed, and page numbers.
  add({ type: "textbox", section: "pageFooter", x: 0, y: 8, w: 260, h: 20, field: "=Now()", format: "General Date", fontSize: 12, color: "#555555", name: "PrintedOn" });
  add({ type: "textbox", section: "pageFooter", x: width - 200, y: 8, w: 200, h: 20, field: '="Page " & [Page] & " of " & [Pages]', align: "right", fontSize: 12, color: "#555555", name: "PageNumbers" });

  const sortField = report.sortBy && byName.has(report.sortBy.toLowerCase()) ? byName.get(report.sortBy.toLowerCase())!.name : undefined;
  return {
    page,
    width,
    sections: { reportHeader: 56, pageHeader: 38, detail: rowH, pageFooter: 36, reportFooter: 40 },
    groups: group ? [{ id: groupId, field: group, header: 38, footer: 34 }] : [],
    sorts: sortField && sortField !== group ? [{ field: sortField }] : [],
    controls,
  };
}

/** Keeps a designed report's field list (used by older views and public copies) in step with its layout. */
export function syncReportColumns(r: ReportDef) {
  if (!r.layout) return;
  const bound = r.layout.controls.filter((c) => c.section === "detail" && c.field && !isExpression(c.field)).sort((a, b) => a.y - b.y || a.x - b.x);
  r.columns = [...new Set(bound.map((c) => c.field!))].slice(0, 255);
  r.groupBy = r.layout.groups[0]?.field;
  if (!r.groupBy) delete r.groupBy;
  r.sortBy = r.layout.sorts[0]?.field;
  if (!r.sortBy) delete r.sortBy;
}

/** A new control of a kind, with Access-like default sizes. */
export function makeReportControl(l: ReportLayout, type: FormControlType, at: { section: string; x: number; y: number; w?: number; h?: number }, extra: Partial<ReportControl> = {}): ReportControl {
  const size: Record<string, [number, number]> = { label: [120, 22], textbox: [160, 22], checkbox: [22, 22], image: [120, 90], rectangle: [180, 90], line: [240, 2] };
  const [w, h] = size[type] ?? [120, 22];
  const base = extra.name ?? (extra.field && !isExpression(extra.field) ? extra.field : type === "label" ? "Label" : type === "textbox" ? "Text" : type[0].toUpperCase() + type.slice(1));
  const taken = new Set(l.controls.map((c) => c.name.toLowerCase()));
  let name = base.replace(/[.![\]`]/g, "_").slice(0, 60) || "Control";
  if (taken.has(name.toLowerCase()) || /^(Label|Text|Line|Rectangle|Image|Checkbox)$/.test(name)) {
    let i = 1;
    const stem = name.replace(/\d+$/, "");
    while (taken.has(`${stem}${i}`.toLowerCase())) i++;
    name = `${stem}${i}`;
  }
  return {
    id: newId("c"),
    type,
    name,
    section: at.section,
    x: at.x,
    y: at.y,
    w: at.w ?? w,
    h: at.h ?? h,
    ...(type === "label" ? { caption: "Label" } : {}),
    ...(type === "line" ? { borderWidth: 1 } : {}),
    ...(type === "checkbox" ? { caption: "" } : {}),
    ...extra,
  } as ReportControl;
}

