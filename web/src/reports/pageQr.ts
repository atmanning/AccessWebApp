/** A report's page QR code: where it goes (this report, publicly or in the app, or another address). */
import type { ReportDef } from "../../../shared/model";
import type { WorkspaceApi } from "../workspace/context";
import { publicLinkFor } from "./PublicReportDialog";

export interface PageQr {
  link: string | null;
  size: number;
  position: NonNullable<ReportDef["pageQr"]>["position"];
  caption?: string;
  /** Why there's no code yet, or a warning. */
  note?: string;
}

export function pageQrFor(ws: WorkspaceApi, report: ReportDef): PageQr | null {
  const q = report.pageQr;
  if (!q) return null;
  const base = (q.baseUrl?.trim() || location.origin).replace(/\/+$/, "");
  const local = /^https?:\/\/(localhost|127\.|\[::1\])/i.test(base) && q.target !== "url";
  let link: string | null = null;
  let note: string | undefined;
  if (q.target === "url") {
    link = q.url?.trim() || null;
    if (!link) note = "Type the web address the QR code opens (Design View → QR code).";
  } else if (q.target === "public") {
    const token = publicLinkFor(ws.projectId, report.id)?.token;
    if (token) link = `${base}/r/${token}`;
    else note = "Make this report public first (🔗 Make public…), so the QR code has a link anyone can open.";
  } else {
    link = `${base}/?${new URLSearchParams({ db: ws.projectId, open: `report:${report.id}` })}`;
  }
  if (local && link) note = `The QR code points to ${base}, which only this computer can open. Set the address phones use in Design View → QR code.`;
  return { link, size: q.size, position: q.position, caption: q.caption, note };
}
