/** A report opened from its public link (/r/…): no sign-in, just the report. */
import { useEffect, useState } from "react";
import type { Field, ReportDef } from "../../../shared/model";
import { api, type ReportSnapshot } from "../api";
import type { ResultSet } from "../engine/engine";
import { ReportBody } from "../views/FormReportViews";
import { LabelsBody } from "./LabelsView";

export const publicReportToken = (): string | null => /^\/r\/([A-Za-z0-9_-]{16,64})\/?$/.exec(location.pathname)?.[1] ?? null;

export function PublicReportPage({ token }: { token: string }) {
  const [state, setState] = useState<{ snapshot?: ReportSnapshot; updatedAt?: string; error?: string }>({});
  useEffect(() => {
    api.getPublicReport(token).then(
      (r) => {
        setState(r);
        document.title = `${r.snapshot.title} - Access Web`;
      },
      (e: Error) => setState({ error: e.message }),
    );
  }, [token]);

  if (state.error) {
    return (
      <div className="public-report-message">
        <h1>This report isn't available</h1>
        <p>{state.error}</p>
      </div>
    );
  }
  if (!state.snapshot) return <div className="public-report-message muted">Loading…</div>;

  const snap = state.snapshot;
  const report = snap.report as unknown as ReportDef;
  const data: ResultSet = { columns: snap.columns, fields: snap.fields as (Field | undefined)[] as ResultSet["fields"], rows: snap.rows };
  const imageUrl = (id: string) => `/api/public-reports/${token}/images/${id}`;
  const updated = state.updatedAt ? new Date(state.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
  const qrIdx = snap.columns.indexOf("__qr");
  // Opened from a name tag: pick out that person.
  const rec = new URLSearchParams(location.search).get("rec");
  const keyIdx = snap.columns.indexOf("__key");
  const highlight = rec !== null && keyIdx >= 0 ? (row: (string | number | boolean | null)[]) => String(row[keyIdx] ?? "") === rec : undefined;
  const found = highlight ? snap.rows.some(highlight) : false;

  return (
    <div className="public-report">
      <div className="public-report-bar">
        <span className="small muted">Updated {updated}</span>
        {found && <span className="public-report-found">★ The highlighted record is the one you scanned.</span>}
        <span className="spacer" />
        {!report.labels && (
          <button className="primary" onClick={() => window.print()}>
            Print…
          </button>
        )}
      </div>
      {report.labels ? (
        <LabelsBody report={report} data={data} qr={qrIdx >= 0 ? { link: (row) => String(row[qrIdx] ?? "") } : {}} hideTips highlight={highlight} />
      ) : (
        <ReportBody report={report} data={data} imageUrl={imageUrl} highlight={highlight} />
      )}
      <div className="public-report-foot small muted">Shared with Access Web</div>
    </div>
  );
}
