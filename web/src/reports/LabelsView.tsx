/**
 * A labels report: one label per record, laid out on sheets at their real size, ready to print on
 * label or name-badge stock. Each label can carry a QR code that opens the record.
 */
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { CellValue, LabelLayout, ReportDef } from "../../../shared/model";
import type { ResultSet } from "../engine/engine";
import { useSource } from "../views/FormReportViews";
import { useCommands, useWorkspace, type WorkspaceApi } from "../workspace/context";
import { fillTemplate, layoutProblem, linkKeyField, PAGE_SIZES, publicRecordLink, recordLink } from "./labels";
import { QrCode } from "./QrCode";
import { PublicLinkButton, publicLinkFor, usePublicLinks } from "./PublicReportDialog";

export function LabelsView({ report, tabKey }: { report: ReportDef; tabKey: string }) {
  const ws = useWorkspace();
  const { data, error } = useSource(report.source);
  useCommands(tabKey, { print: () => window.print() });
  // Redraw when public links load (QR codes that open a public report need its link).
  usePublicLinks(ws.projectId);
  if (error) return <div className="query-error"><strong>These labels can't open.</strong><p>{error}</p></div>;
  if (!data) return <div className="empty-view">Loading…</div>;
  return <LabelsBody report={report} data={data} qr={qrFor(ws, report, data)} extra={<PublicLinkButton report={report} />} />;
}

/** Labels drawn from their data: in the app, and on a public report link. */
export function LabelsBody({
  report,
  data,
  qr,
  extra,
  hideTips,
  highlight,
}: {
  report: ReportDef;
  data: ResultSet;
  qr: QrLinks;
  extra?: ReactNode;
  hideTips?: boolean;
  highlight?: (row: CellValue[]) => boolean;
}) {
  const l = report.labels!;
  const rows = sortedRows(data, report.sortBy);
  const perPage = l.across * l.down;
  const slots: (CellValue[] | null)[] = [...Array<null>(l.skip ?? 0).fill(null), ...rows];
  const pages: (CellValue[] | null)[][] = [];
  for (let i = 0; i < slots.length; i += perPage) pages.push(slots.slice(i, i + perPage));
  if (!pages.length) pages.push([]);
  const page = PAGE_SIZES[l.page];
  const problem = layoutProblem(l);
  const sheets = <Sheets pages={pages} l={l} data={data} qr={qr} page={page} highlight={highlight} />;

  return (
    <div className="labels-view">
      {/* @page sets the paper size and removes the browser's margins, so labels land where they should. */}
      <style>{`@media print { @page { size: ${page.css}; margin: 0; } }`}</style>
      <div className="labels-toolbar">
        <strong>{report.title || report.name}</strong>
        <span className="muted">
          {rows.length} label{rows.length === 1 ? "" : "s"} on {pages.length} sheet{pages.length === 1 ? "" : "s"} · {l.width}″ × {l.height}″, {l.across} across × {l.down} down
        </span>
        <span className="spacer" />
        {extra}
        <button className="primary" onClick={() => window.print()}>
          Print…
        </button>
      </div>
      <div className="labels-tips small" hidden={hideTips}>
        In the print dialog, set <strong>Margins</strong> to <em>None</em> and <strong>Scale</strong> to <em>100%</em> (Actual size). Print one sheet on plain
        paper first and hold it against a label sheet to check the alignment; adjust the margins in Design View if needed.
        {problem && <div className="field-error">{problem}</div>}
        {qr.note && <div className="labels-note">{qr.note}</div>}
      </div>
      <div className="labels-pages">{sheets}</div>
      {/* Printed from a copy at the top of the page, outside the app's scrolling panes, so every sheet prints. */}
      {createPortal(<div className="labels-print">{sheets}</div>, document.body)}
    </div>
  );
}

function Sheets({
  pages,
  l,
  data,
  qr,
  page,
  highlight,
}: {
  pages: (CellValue[] | null)[][];
  l: LabelLayout;
  data: ResultSet;
  qr: { link?: (row: CellValue[]) => string };
  page: { w: number; h: number };
  highlight?: (row: CellValue[]) => boolean;
}) {
  return (
    <>
        {pages.map((slots, p) => (
          <div key={p} className="label-page" style={{ width: `${page.w}in`, height: `${page.h}in` }}>
            {slots.map((row, i) =>
              row ? (
                <div
                  key={i}
                  className={`label ${l.outline ? "outlined" : ""} ${highlight?.(row) ? "highlight" : ""}`}
                  style={labelBox(l, i)}
                  ref={highlight?.(row) ? (el) => el?.scrollIntoView({ block: "center" }) : undefined}
                >
                  <LabelContent l={l} lines={l.lines.map((line) => fillTemplate(line.text, data.columns, data.fields, row))} qr={qr.link?.(row)} />
                </div>
              ) : null,
            )}
          </div>
        ))}
    </>
  );
}

function sortedRows(data: ResultSet, sortBy?: string) {
  const rows = [...data.rows];
  const i = sortBy ? data.columns.findIndex((c) => c === sortBy) : -1;
  if (i >= 0) rows.sort((a, b) => String(a[i] ?? "").localeCompare(String(b[i] ?? ""), undefined, { numeric: true, sensitivity: "base" }));
  return rows;
}

/** Where label number `i` on a sheet goes (left to right, then down). */
export function labelBox(l: LabelLayout, i: number): CSSProperties {
  const col = i % l.across;
  const row = Math.floor(i / l.across);
  return {
    left: `${l.marginLeft + col * (l.width + l.gapX)}in`,
    top: `${l.marginTop + row * (l.height + l.gapY)}in`,
    width: `${l.width}in`,
    height: `${l.height}in`,
    padding: `${l.padding}in`,
  };
}

export type QrLinks = { link?: (row: CellValue[]) => string; note?: string };

/** How each label's QR code finds its record, or why there can't be one. */
export function qrFor(ws: WorkspaceApi, report: ReportDef, data: ResultSet): QrLinks {
  const q = report.labels?.qr;
  if (!q) return {};
  if (q.target === "public") return publicQr(ws, report, data);
  const key = linkKeyField(ws.doc, report.source, { kind: q.target, formId: q.formId });
  const ki = key ? data.columns.findIndex((c) => c.toLowerCase() === key.toLowerCase()) : -1;
  if (!key || ki < 0) {
    return { note: `QR codes need a way to find each record: the ${report.source.kind === "query" ? "query must include the table's primary key" : "table needs a primary key"}.` };
  }
  const form = q.target === "form" ? ws.doc.forms.find((f) => f.id === q.formId) : undefined;
  const tableId = form?.source.kind === "table" ? form.source.id : report.source.kind === "table" ? report.source.id : null;
  const open = form ? { kind: "form" as const, id: form.id } : tableId ? { kind: "table" as const, id: tableId } : null;
  if (!open) return { note: "Choose the form QR codes open (Design View → QR code)." };
  const base = q.baseUrl?.trim() || location.origin;
  const local = /^https?:\/\/(localhost|127\.|\[::1\])/i.test(base);
  return {
    link: (row) => recordLink(base, ws.projectId, open, key, row[ki]),
    note: local
      ? `QR codes point to ${base}, which only this computer can open. Set the address phones should use under QR code in Design View (for example this computer's network address, or your hosted site).`
      : undefined,
  };
}

/** QR codes that open a public report (no sign-in), carrying each person's key. */
function publicQr(ws: WorkspaceApi, report: ReportDef, data: ResultSet): QrLinks {
  const q = report.labels!.qr!;
  const target = ws.doc.reports.find((r) => r.id === q.publicReportId);
  if (!target) return { note: "Choose the public report the QR codes open (Design View → QR code)." };
  const token = publicLinkFor(ws.projectId, target.id)?.token;
  if (!token) return { note: `Make the report "${target.name}" public first: open it and click 🔗 Make public… Until then these labels have no QR codes.` };
  const key = linkKeyField(ws.doc, report.source);
  const ki = key ? data.columns.findIndex((c) => c.toLowerCase() === key.toLowerCase()) : -1;
  const base = q.baseUrl?.trim() || location.origin;
  const local = /^https?:\/\/(localhost|127\.|\[::1\])/i.test(base);
  return {
    link: (row) => (key && ki >= 0 ? publicRecordLink(base, token, key, row[ki]) : `${base.replace(/\/+$/, "")}/r/${token}`),
    note: local
      ? `QR codes point to ${base}, which only this computer can open. Set the address phones should use under QR code in Design View.`
      : !key || ki < 0
        ? "Every code opens the same page: the table needs a primary key for scans to tell people apart (and for the scan station)."
        : `Keep "${target.name}" public: turning its link off and on again makes a new link, and printed tags would stop working.`,
  };
}

export function LabelContent({ l, lines, qr }: { l: LabelLayout; lines: string[]; qr?: string }): ReactNode {
  const pos = l.qr?.position ?? "right";
  const code = qr && l.qr ? <QrCode text={qr} size={`${l.qr.size}in`} title="Scan to open this record" /> : null;
  return (
    <div className={`label-inner qr-${pos}`} style={{ textAlign: l.align }}>
      {code && pos === "left" && code}
      <div className="label-lines" style={{ alignItems: l.align === "center" ? "center" : l.align === "right" ? "flex-end" : "flex-start" }}>
        {l.lines.map((line, i) => (
          <div key={i} className="label-line" style={{ fontSize: `${line.size}pt`, fontWeight: line.bold ? 700 : 400, fontStyle: line.italic ? "italic" : undefined }}>
            {lines[i] || " "}
          </div>
        ))}
      </div>
      {code && pos !== "left" && code}
    </div>
  );
}
