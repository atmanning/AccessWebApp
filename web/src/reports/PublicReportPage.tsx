/** A report opened from its public link (/r/…): no sign-in, just the report. */
import { useEffect, useState } from "react";
import type { Field, ReportDef } from "../../../shared/model";
import { api, type ReportSnapshot } from "../api";
import type { ResultSet } from "../engine/engine";
import { ReportBody } from "../views/FormReportViews";
import { LabelsBody } from "./LabelsView";
import { localNow } from "../scan/scanActions";

/**
 * Staff who scan a name tag (signed in, and allowed by the database's owner) can record things for
 * that person here: Take attendance, an achievement… Everyone else just sees the public report.
 */
function RecordPanel({ token, recKey, rec }: { token: string; recKey: string; rec: string }) {
  type Opt = { id: string; name: string; done: string | null; busy?: boolean; error?: string };
  const [state, setState] = useState<{ signedIn?: boolean; person?: string | null; actions: Opt[] } | null>(null);
  useEffect(() => {
    api.publicRecordOptions(token, recKey, rec).then(
      (r) => setState(r),
      () => setState({ signedIn: false, actions: [] }),
    );
  }, [token, recKey, rec]);
  if (!state) return null;
  if (!state.signedIn) {
    return (
      <div className="record-panel signed-out">
        <a href={`/?next=${encodeURIComponent(location.pathname + location.search)}`}>Staff: sign in to record attendance or achievements</a>
      </div>
    );
  }
  if (!state.actions.length) return null;
  const record = async (o: Opt) => {
    setState((s) => s && { ...s, actions: s.actions.map((x) => (x.id === o.id ? { ...x, busy: true, error: undefined } : x)) });
    try {
      const r = await api.publicRecord(token, { actionId: o.id, key: recKey, rec, now: localNow() });
      const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      setState(
        (s) =>
          s && {
            ...s,
            actions: s.actions.map((x) => (x.id === o.id ? { ...x, busy: false, done: r.ok ? `Recorded ${time}` : r.already ? r.message : null, error: r.ok || r.already ? undefined : r.message } : x)),
          },
      );
    } catch (e) {
      setState((s) => s && { ...s, actions: s.actions.map((x) => (x.id === o.id ? { ...x, busy: false, error: (e as Error).message } : x)) });
    }
  };
  return (
    <div className="record-panel" role="region" aria-label="Record">
      <div className="record-title">
        Record for <strong>{state.person}</strong>
      </div>
      {state.actions.map((o) => (
        <label key={o.id} className={`record-row ${o.done ? "done" : ""}`}>
          <input type="checkbox" checked={!!o.done} disabled={!!o.done || o.busy} onChange={() => void record(o)} />
          <span className="record-name">{o.name}</span>
          <span className="record-status">{o.busy ? "Saving…" : o.error ? <span className="field-error">{o.error}</span> : o.done ? `✓ ${o.done}` : ""}</span>
        </label>
      ))}
    </div>
  );
}

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
  const key = new URLSearchParams(location.search).get("key");
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
      {rec !== null && key && <RecordPanel token={token} recKey={key} rec={rec} />}
      {report.labels ? (
        <LabelsBody report={report} data={data} qr={qrIdx >= 0 ? { link: (row) => String(row[qrIdx] ?? "") } : {}} hideTips highlight={highlight} fitWidth />
      ) : (
        <ReportBody report={report} data={data} imageUrl={imageUrl} highlight={highlight} />
      )}
      <div className="public-report-foot small muted">Shared with Access Web</div>
    </div>
  );
}
