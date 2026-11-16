/**
 * Laying a designed report out on pages, as Access prints it: the records sorted by the group
 * levels and sorts, a header before and a footer after each group, the report header at the start
 * and the report footer at the end, a page header at the top and a page footer at the bottom of
 * every page. Sections move to the next page when they don't fit (a group header never sits alone
 * at the bottom), and honour Force New Page and Keep Together.
 */
import type { CellValue, ReportLayout } from "../../../shared/model";
import { DPI, pageSize, sectionHeight } from "./reportLayout";

export interface Band {
  key: string;
  h: number;
  /** The record the section shows (a group header/footer: the group's first/last record). */
  row: readonly CellValue[] | null;
  /** The record before (for Hide Duplicates). */
  prev: readonly CellValue[] | null;
  /** Records for totals: the group's, or every record for the report header and footer. */
  records: readonly (readonly CellValue[])[];
  /** Index of the record in the sorted list (detail sections). */
  index?: number;
}

export interface PlacedBand extends Band {
  top: number;
}

export interface ReportPage {
  bands: PlacedBand[];
}

export interface Pagination {
  pages: ReportPage[];
  /** Records in print order. */
  rows: readonly (readonly CellValue[])[];
  /** Page size and printable area in pixels. */
  page: { w: number; h: number; contentW: number; contentH: number; margins: { top: number; right: number; bottom: number; left: number } };
}

const compare = (a: CellValue, b: CellValue) => {
  if (a === b) return 0;
  if (a === null || a === undefined || a === "") return -1;
  if (b === null || b === undefined || b === "") return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" || typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
};
const same = (a: CellValue | undefined, b: CellValue | undefined) => (a ?? null) === (b ?? null) || String(a ?? "") === String(b ?? "");

/** Records sorted by the group levels, then the sorts. */
export function sortRows(l: ReportLayout, columns: readonly string[], rows: readonly (readonly CellValue[])[]) {
  const idx = (f: string) => columns.findIndex((c) => c.toLowerCase() === f.toLowerCase());
  const keys = [...l.groups.map((g) => ({ i: idx(g.field), d: !!g.descending })), ...l.sorts.map((s) => ({ i: idx(s.field), d: !!s.descending }))].filter((k) => k.i >= 0);
  if (!keys.length) return [...rows];
  return rows
    .map((r, n) => ({ r, n }))
    .sort((a, b) => {
      for (const k of keys) {
        const c = compare(a.r[k.i], b.r[k.i]);
        if (c) return k.d ? -c : c;
      }
      return a.n - b.n;
    })
    .map((x) => x.r);
}

/** The sequence of sections a report prints, before it's split into pages. */
export function buildBands(l: ReportLayout, columns: readonly string[], sorted: readonly (readonly CellValue[])[]): Band[] {
  const hidden = (key: string) => !!l.sectionProps?.[key]?.hidden;
  const levels = l.groups.map((g) => ({ g, i: columns.findIndex((c) => c.toLowerCase() === g.field.toLowerCase()) }));
  const out: Band[] = [];
  const push = (key: string, b: Omit<Band, "key" | "h">) => {
    const h = sectionHeight(l, key);
    if (h > 0 && !hidden(key)) out.push({ key, h, ...b });
  };
  push("reportHeader", { row: sorted[0] ?? null, prev: null, records: sorted });

  // Level i changes between records a and b when any of the fields of levels 0..i differ.
  const changes = (a: readonly CellValue[] | undefined, b: readonly CellValue[] | undefined, level: number) => {
    if (!a || !b) return true;
    for (let k = 0; k <= level; k++) if (levels[k].i >= 0 && !same(a[levels[k].i], b[levels[k].i])) return true;
    return false;
  };
  const groupEnd = (start: number, level: number) => {
    let e = start + 1;
    while (e < sorted.length && !changes(sorted[start], sorted[e], level)) e++;
    return e;
  };
  const starts: number[] = levels.map(() => 0);
  const ends: number[] = levels.map(() => sorted.length);
  for (let n = 0; n < sorted.length; n++) {
    const row = sorted[n];
    const prev = sorted[n - 1];
    const first = levels.findIndex((_, k) => changes(prev, row, k));
    if (first >= 0) {
      for (let k = first; k < levels.length; k++) {
        starts[k] = n;
        ends[k] = groupEnd(n, k);
        push(`gh:${levels[k].g.id}`, { row, prev: prev ?? null, records: sorted.slice(n, ends[k]) });
      }
    }
    const inner = levels.length - 1;
    push("detail", { row, prev: prev ?? null, records: inner >= 0 ? sorted.slice(starts[inner], ends[inner]) : sorted, index: n });
    const next = sorted[n + 1];
    const last = levels.findIndex((_, k) => changes(row, next, k));
    if (last >= 0) {
      for (let k = levels.length - 1; k >= last; k--) push(`gf:${levels[k].g.id}`, { row, prev: prev ?? null, records: sorted.slice(starts[k], n + 1) });
    }
  }
  push("reportFooter", { row: sorted[sorted.length - 1] ?? null, prev: null, records: sorted });
  return out;
}

/** Splits the report into pages. */
export function paginate(l: ReportLayout, columns: readonly string[], rows: readonly (readonly CellValue[])[]): Pagination {
  const ps = pageSize(l);
  const m = l.page.margins;
  const page = {
    w: Math.round(ps.w * DPI),
    h: Math.round(ps.h * DPI),
    contentW: Math.round(ps.printableW * DPI),
    contentH: Math.round(ps.printableH * DPI),
    margins: { top: Math.round(m.top * DPI), right: Math.round(m.right * DPI), bottom: Math.round(m.bottom * DPI), left: Math.round(m.left * DPI) },
  };
  const sorted = sortRows(l, columns, rows);
  const bands = buildBands(l, columns, sorted);
  const props = (key: string) => l.sectionProps?.[key];
  const pageHeaderH = props("pageHeader")?.hidden ? 0 : l.sections.pageHeader;
  const pageFooterH = props("pageFooter")?.hidden ? 0 : l.sections.pageFooter;
  const avail = Math.max(24, page.contentH - pageFooterH);

  const pages: ReportPage[] = [];
  let cur: ReportPage;
  let y = 0;
  let body = false;
  const newPage = () => {
    cur = { bands: [] };
    pages.push(cur);
    y = 0;
    body = false;
    // Page 1 starts with the report header; the page header follows it.
    if (pages.length > 1 && pageHeaderH > 0) {
      cur.bands.push({ key: "pageHeader", h: pageHeaderH, row: lastRow, prev: null, records: [], top: 0 });
      y = pageHeaderH;
    }
  };
  let lastRow: readonly CellValue[] | null = sorted[0] ?? null;
  newPage();
  let breakNext = false;

  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const isGroupHeader = b.key.startsWith("gh:");
    const p = props(b.key);
    if ((breakNext || p?.forceNewPage === "before") && body) newPage();
    breakNext = false;
    // Space this section needs here: itself, plus (a group header) the next section, so a
    // header never ends a page; or (Keep Together on the group) the whole group, when it fits on a page.
    let need = b.h;
    if (isGroupHeader) {
      const g = l.groups.find((x) => x.id === b.key.slice(3));
      if (g?.keepTogether) {
        let total = 0;
        for (let k = i; k < bands.length; k++) {
          total += bands[k].h;
          if (bands[k].key === `gf:${g.id}`) break;
          if (k > i && bands[k].key === b.key) break;
        }
        if (total <= avail - (pageHeaderH || 0)) need = total;
      } else if (bands[i + 1]) need += bands[i + 1].h;
    }
    if (y + need > avail && body) newPage();
    if (i === 0 && b.key === "reportHeader") {
      cur!.bands.push({ ...b, top: y });
      y += b.h;
      if (pageHeaderH > 0) {
        cur!.bands.push({ key: "pageHeader", h: pageHeaderH, row: b.row, prev: null, records: [], top: y });
        y += pageHeaderH;
      }
      if (p?.forceNewPage === "after") breakNext = true;
      continue;
    }
    if (i === 0 && pageHeaderH > 0) {
      cur!.bands.push({ key: "pageHeader", h: pageHeaderH, row: b.row, prev: null, records: [], top: y });
      y += pageHeaderH;
    }
    cur!.bands.push({ ...b, top: y });
    y += b.h;
    body = true;
    if (b.row) lastRow = b.row;
    if (p?.forceNewPage === "after") breakNext = true;
  }
  // A report with nothing in it still has its page header.
  if (!bands.length && pageHeaderH > 0) cur!.bands.push({ key: "pageHeader", h: pageHeaderH, row: null, prev: null, records: [], top: 0 });
  // Page footers along the bottom of every page.
  if (pageFooterH > 0) {
    for (const pg of pages) {
      const lastOnPage = [...pg.bands].reverse().find((b) => b.row);
      pg.bands.push({ key: "pageFooter", h: pageFooterH, row: lastOnPage?.row ?? null, prev: null, records: [], top: page.contentH - pageFooterH });
    }
  }
  return { pages, rows: sorted, page };
}
