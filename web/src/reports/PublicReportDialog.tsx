/**
 * Public report links: anyone with the link sees the report, without signing in. The link shows a
 * copy of only what the report shows (its columns and rows), never the rest of the database. The
 * copy is refreshed whenever someone who can edit has the database open and the data changes.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { CellValue, ReportDef } from "../../../shared/model";
import { api, type PublicReportLink, type ReportSnapshot } from "../api";
import { readSource } from "../engine/engine";
import { Modal } from "../ui/dialogs";
import { useWorkspace, type WorkspaceApi } from "../workspace/context";
import { qrFor } from "./LabelsView";
import { linkKeyField } from "./labels";

export const publicReportUrl = (token: string) => `${location.origin}/r/${token}`;

// ---- The links of the open database, shared by the button, the dialog and the refresher.
let links = new Map<string, PublicReportLink>();
let linksFor = "";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function setLinks(pid: string, next: Map<string, PublicReportLink>) {
  linksFor = pid;
  links = next;
  emit();
}
/** A report's public link in the open database, if it has one. */
export const publicLinkFor = (pid: string, reportId: string | undefined) => (linksFor === pid && reportId ? links.get(reportId) : undefined);

export function usePublicLinks(pid: string): Map<string, PublicReportLink> {
  const all = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => links,
  );
  return linksFor === pid ? all : new Map();
}

/** Fields named in a label line: [FirstName] [Last Name] */
const placeholders = (text: string) => [...text.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);

/** The report's data, cut down to the columns it shows (plus each label's QR link). */
export async function buildSnapshot(ws: WorkspaceApi, report: ReportDef): Promise<ReportSnapshot> {
  const data = await readSource(ws.doc, report.source);
  const wanted = new Set(
    [
      ...(report.labels ? report.labels.lines.flatMap((l) => placeholders(l.text)) : report.columns),
      report.groupBy,
      report.sortBy,
    ]
      .filter((n): n is string => !!n)
      .map((n) => n.toLowerCase()),
  );
  const keep = data.columns.map((c, i) => (wanted.has(c.toLowerCase()) ? i : -1)).filter((i) => i >= 0);
  const qr = report.labels?.qr ? qrFor(ws, report, data).link : undefined;
  // Each record's key (e.g. PersonID), so a scanned name tag can highlight its person.
  const keyName = linkKeyField(ws.doc, report.source);
  const ki = keyName ? data.columns.findIndex((c) => c.toLowerCase() === keyName.toLowerCase()) : -1;
  const columns = keep.map((i) => data.columns[i]);
  const rows: CellValue[][] = data.rows.map((r) => [...keep.map((i) => r[i] ?? null), ...(qr ? [qr(r)] : []), ...(ki >= 0 ? [r[ki] ?? null] : [])]);
  return {
    v: 1,
    title: report.title || report.name,
    report: { ...report, source: { kind: "table", id: "snapshot" } },
    columns: [...columns, ...(qr ? ["__qr"] : []), ...(ki >= 0 ? ["__key"] : [])],
    fields: [...keep.map((i) => (data.fields[i] ? { type: data.fields[i]!.type } : null)), ...(qr ? [null] : []), ...(ki >= 0 ? [null] : [])],
    rows,
  };
}

/**
 * Keeps public report links up to date while an owner or editor has the database open: when the
 * data changes, each public report's copy is rebuilt and sent if it's different.
 */
export function usePublicReportSync(ws: WorkspaceApi) {
  const canRefresh = ws.signedIn && ws.role !== "view";
  const pid = ws.projectId;
  const mine = usePublicLinks(pid);
  const [sent] = useState(() => new Map<string, string>());

  useEffect(() => {
    if (!ws.signedIn) return;
    api
      .listPublicReports(pid)
      .then((r) => setLinks(pid, new Map(r.reports.map((x) => [x.reportId, x]))))
      .catch(() => {});
  }, [pid, ws.signedIn]);

  useEffect(() => {
    if (!canRefresh || !mine.size) return;
    const timer = setTimeout(async () => {
      for (const link of mine.values()) {
        const report = ws.doc.reports.find((r) => r.id === link.reportId);
        if (!report) continue;
        try {
          const snap = await buildSnapshot(ws, report);
          const text = JSON.stringify(snap);
          if (sent.get(link.reportId) === text) continue;
          const r = await api.publishReport(pid, link.reportId, snap);
          sent.set(link.reportId, text);
          setLinks(pid, new Map(links).set(link.reportId, { ...link, updatedAt: r.updatedAt }));
        } catch {
          // Tried again on the next change.
        }
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [ws.doc, canRefresh, mine.size]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The report's "Public link" button: opens the dialog (owners), or copies the link (others). */
export function PublicLinkButton({ report }: { report: ReportDef }) {
  const ws = useWorkspace();
  const link = usePublicLinks(ws.projectId).get(report.id);
  const [open, setOpen] = useState(false);
  if (!ws.signedIn || (ws.role !== "owner" && !link)) return null;
  return (
    <>
      <button className={`public-link-button ${link ? "on" : ""}`} onClick={() => setOpen(true)} title={link ? "This report is public. Click to copy or stop sharing its link." : "Let anyone with a link see this report, without signing in"}>
        🔗 {link ? "Public link" : "Make public…"}
      </button>
      {open && <PublicReportDialog report={report} onClose={() => setOpen(false)} />}
    </>
  );
}

export function PublicReportDialog({ report, onClose }: { report: ReportDef; onClose: () => void }) {
  const ws = useWorkspace();
  const link = usePublicLinks(ws.projectId).get(report.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const owner = ws.role === "owner";

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      const snap = await buildSnapshot(ws, report);
      const r = await api.publishReport(ws.projectId, report.id, snap);
      setLinks(ws.projectId, new Map(links).set(report.id, { reportId: report.id, token: r.token, updatedAt: r.updatedAt }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.unpublishReport(ws.projectId, report.id);
      const next = new Map(links);
      next.delete(report.id);
      setLinks(ws.projectId, next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(publicReportUrl(link.token));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy. Select the link and copy it yourself.");
    }
  };
  const when = link ? new Date(link.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";

  return (
    <Modal title={`Public link: ${report.name}`} onClose={onClose} width={520} footer={<><span className="spacer" /><button onClick={onClose}>Done</button></>}>
      <div className="pub">
        <label className="pub-toggle">
          <input type="checkbox" checked={!!link} disabled={!owner || busy} onChange={(e) => void (e.target.checked ? publish() : stop())} />
          <span>
            <strong>Anyone with the link can view this report</strong>
            <span className="small muted"> — no sign-in needed</span>
          </span>
        </label>
        {link ? (
          <>
            <div className="pub-link">
              <input readOnly value={publicReportUrl(link.token)} aria-label="Public link" onFocus={(e) => e.target.select()} />
              <button className="primary" onClick={copy}>
                {copied ? "Copied ✓" : "Copy link"}
              </button>
            </div>
            <p className="small muted pub-note">
              Last updated {when}. It updates by itself when the data changes while you (or an editor) have this database open.{" "}
              {owner && (
                <button className="link-button" disabled={busy} onClick={publish}>
                  Update now
                </button>
              )}
            </p>
          </>
        ) : (
          <p className="small pub-note">{owner ? "Turn this on to get a link you can send to anyone, or put on a website." : "Only the database's owner can make a report public."}</p>
        )}
        <div className="pub-what small">
          <strong>What people see:</strong> only this report: its title and the columns and records it shows. They can't see your other tables, queries or forms, can't
          change anything, and don't need an account. Turning the link off stops it working; turning it on again makes a new link.
        </div>
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
