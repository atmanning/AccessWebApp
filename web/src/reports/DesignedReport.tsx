/**
 * Report View of a designed report: real pages at the paper size, with each section placed and its
 * controls filled in (fields, calculated values, totals over the group, page numbers). Printing
 * prints exactly these pages.
 */
import { useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { CellValue, ProjectDoc, ReportControl, ReportDef, ReportLayout } from "../../../shared/model";
import type { ResultSet } from "../engine/engine";
import { displayValue, isExpression, toExpr } from "../engine/expr";
import { formatValue } from "../engine/values";
import { makeFormCalc } from "../forms/formCalc";
import { QrCode } from "./QrCode";
import type { PageQr } from "./pageQr";
import { ReportControlView, type ReportCellContent } from "./ReportControlView";
import { pageSize } from "./reportLayout";
import { paginate, type PlacedBand } from "./reportPages";

const EMPTY_DOC = { version: 1, tables: [], queries: [], forms: [], reports: [], relationships: [] } as unknown as ProjectDoc;

export function DesignedReport(props: {
  report: ReportDef & { layout: ReportLayout };
  data: ResultSet;
  doc?: ProjectDoc;
  imageUrl: (id: string) => string;
  toolbar?: ReactNode;
  pageQr?: PageQr | null;
  highlight?: (row: CellValue[]) => boolean;
  /** Shrink the pages to fit a narrow screen (a phone opening a public link). */
  fitWidth?: boolean;
}) {
  const { report, data } = props;
  const l = report.layout;
  const result = useMemo(() => paginate(l, data.columns, data.rows), [l, data]);
  const calc = useMemo(() => makeFormCalc(props.doc ?? EMPTY_DOC, l as never, data.columns), [props.doc, l, data.columns]);
  const ps = pageSize(l);
  const baseFont = l.fontSize ?? 14;
  const colIdx = useMemo(() => new Map(data.columns.map((c, i) => [c.toLowerCase(), i])), [data.columns]);
  const bySection = useMemo(() => {
    const m = new Map<string, ReportControl[]>();
    for (const c of l.controls) {
      if (c.hidden) continue;
      const list = m.get(c.section) ?? [];
      list.push(c);
      m.set(c.section, list);
    }
    return m;
  }, [l.controls]);
  const total = result.pages.length;

  const contentFor = (c: ReportControl, b: PlacedBand, pageNo: number): ReportCellContent | undefined => {
    if (c.type === "label" || c.type === "rectangle" || c.type === "line") return undefined;
    if (c.type === "image" && !c.field) return { imageSrc: c.picture ? props.imageUrl(c.picture) : null };
    if (!c.field) return { text: "" };
    if (isExpression(c.field)) {
      const r = calc.value(c as never, b.row as CellValue[] | null, () => b.records as CellValue[][], { Page: pageNo, Pages: total });
      return c.type === "checkbox" ? { checked: !!r.value } : { text: r.text, error: r.error };
    }
    const i = colIdx.get(c.field.toLowerCase());
    if (i === undefined) return { text: "#Name?", error: `The record source has no field named ${c.field}.` };
    const v = b.row ? b.row[i] : null;
    if (c.hideDuplicates && b.key === "detail" && b.prev && String(b.prev[i] ?? "") === String(v ?? "")) return { text: "" };
    if (c.type === "checkbox") return { checked: v === true || v === 1 || v === "Yes" };
    if (c.type === "image") return { imageSrc: v ? props.imageUrl(String(v)) : null };
    return { text: c.format ? displayValue(toExpr(v), c.format) : formatValue(data.fields[i], v) };
  };

  const sectionBack = (key: string) => l.sectionProps?.[key]?.backColor;
  // Shrink the pages to fit a phone's screen (always on a public link).
  const narrow = props.fitWidth || window.innerWidth < 700;
  const zoom = narrow ? Math.min(1, (window.innerWidth - 24) / (ps.w * 96)) : 1;
  const q = props.pageQr;

  const pages = result.pages.map((pg, p) => (
    <div key={p} className="rd-page" style={{ width: `${ps.w}in`, height: `${ps.h}in` }}>
      <div className="rd-content" style={{ left: result.page.margins.left, top: result.page.margins.top, width: result.page.contentW, height: result.page.contentH }}>
        {pg.bands.map((b, bi) => {
          const hit = b.key === "detail" && b.row && props.highlight?.(b.row as CellValue[]);
          return (
            <div
              key={bi}
              className={`rd-band ${hit ? "highlight" : ""}`}
              style={{ top: b.top, height: b.h, width: l.width, background: sectionBack(b.key) }}
              ref={hit ? (el) => el?.scrollIntoView({ block: "center", inline: "nearest" }) : undefined}
            >
              {(bySection.get(b.key) ?? []).map((c) => (
                <div key={c.id} className={`rd-ctl t-${c.type}`} style={{ left: c.x, top: c.y, width: c.w, height: c.h }}>
                  <ReportControlView c={c} baseFont={baseFont} content={contentFor(c, b, p + 1)} />
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {q?.link && (
        <div className={`rd-qr ${q.position}`} style={{ width: `${q.size}in` }}>
          <QrCode text={q.link} size={`${q.size}in`} title={q.caption || "Scan to open"} />
          {q.caption && <div className="report-qr-caption">{q.caption}</div>}
        </div>
      )}
    </div>
  ));

  return (
    <div className="rd-view">
      {/* @page sets the paper size; the margins are part of each page, so the browser's are removed. */}
      <style>{`@media print { @page { size: ${ps.css}; margin: 0; } }`}</style>
      <div className="labels-toolbar">
        <strong>{report.title || report.name}</strong>
        <span className="muted">
          {result.rows.length} record{result.rows.length === 1 ? "" : "s"} · {total} page{total === 1 ? "" : "s"}
        </span>
        <span className="spacer" />
        {props.toolbar}
        <button className="primary" onClick={() => window.print()}>
          Print…
        </button>
      </div>
      {l.width > result.page.contentW + 1 && (
        <div className="labels-tips small">
          <span className="labels-note">
            The report is {((l.width - result.page.contentW) / 96).toFixed(2)}″ wider than the space between the margins, so its right side is cut off. Make it narrower,
            or use smaller margins or landscape in Design View.
          </span>
        </div>
      )}
      <div className="rd-pages" style={zoom < 1 ? { zoom } : undefined}>
        {pages}
      </div>
      {/* Printed from a copy outside the app's scrolling panes, so every page prints. */}
      {createPortal(<div className="labels-print rd-print">{pages}</div>, document.body)}
    </div>
  );
}
