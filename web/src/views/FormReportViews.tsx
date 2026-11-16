import { useEffect, useMemo, useState } from "react";
import { PublicLinkButton } from "../reports/PublicReportDialog";
import { pageQrFor } from "../reports/pageQr";
import { usePublicLinks } from "../reports/PublicReportDialog";
import type { FormDef, ReportDef, SourceRef } from "../../../shared/model";
import { readSource, type ResultSet } from "../engine/engine";
import { ComboBox } from "../ui/ComboBox";
import { DesignedReport } from "../reports/DesignedReport";
import { wizardLayout } from "../reports/reportLayout";
import { useCommands, useWorkspace, type OpenArgs } from "../workspace/context";
import { truthy } from "../engine/expr";
import { makeFormCalc } from "../forms/formCalc";

/** An unbound form's one "record": no fields (its controls hold their own values). */
const UNBOUND: ResultSet = { columns: [], fields: [], rows: [[]] };

/** Loads a form/report's record source; tables are read synchronously so edits show instantly. */
export function useSource(source: SourceRef | undefined) {
  const ws = useWorkspace();
  const [queryResult, setQueryResult] = useState<{ data?: ResultSet; error?: string }>({});
  const table = source?.kind === "table" ? ws.doc.tables.find((t) => t.id === source.id) : undefined;

  useEffect(() => {
    if (source?.kind !== "query") return;
    let cancelled = false;
    readSource(ws.doc, source)
      .then((data) => !cancelled && setQueryResult({ data }))
      .catch((e: Error) => !cancelled && setQueryResult({ error: e.message }));
    return () => {
      cancelled = true;
    };
  }, [ws.doc, source?.kind, source?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const tableData = useMemo<ResultSet | undefined>(
    () =>
      table && {
        columns: table.fields.map((f) => f.name),
        fields: table.fields,
        rows: table.rows.map((r) => table.fields.map((f) => r[f.id] ?? null)),
      },
    [table],
  );

  if (!source) return { data: UNBOUND, table: undefined };
  if (source.kind === "table") {
    return table ? { data: tableData, table } : { error: "The table this object is based on was deleted." };
  }
  return { ...queryResult, table: undefined };
}

export function ReportView({ report, tabKey, open }: { report: ReportDef; tabKey: string; open?: OpenArgs }) {
  const { data: all, error } = useSource(report.source);
  const ws = useWorkspace();
  // Opened by a macro with a Where Condition: only the matching records.
  const { data, whereError } = useMemo(() => {
    if (!all || !open?.where) return { data: all, whereError: null };
    try {
      const calc = makeFormCalc(ws.doc, { controls: [] }, all.columns);
      return { data: { ...all, rows: all.rows.filter((r) => truthy(calc.evaluate(open.where!, r, () => []))) }, whereError: null };
    } catch (e) {
      return { data: all, whereError: `The Where Condition ${open.where} can't be worked out: ${(e as Error).message}` };
    }
  }, [all, open?.where, open?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (whereError) ws.setStatus(whereError, "error");
  }, [whereError]); // eslint-disable-line react-hooks/exhaustive-deps
  // OpenReport with View: Print prints it once it's laid out.
  useEffect(() => {
    if (!open?.print || !data) return;
    const t = setTimeout(() => window.print(), 300);
    return () => clearTimeout(t);
  }, [open?.n, !!data]); // eslint-disable-line react-hooks/exhaustive-deps
  useCommands(tabKey, { print: () => window.print() });
  // Redraw when public links load (a page QR code to this report's public link needs it).
  usePublicLinks(ws.projectId);
  // Reports without a design yet show the Report Wizard layout Design View starts from.
  const layout = useMemo(() => (data ? (report.layout ?? wizardLayout(report, data.columns.map((name, i) => ({ name, field: data.fields[i] })))) : null), [report, data]);
  if (error) return <div className="query-error"><strong>This report can't open.</strong><p>{error}</p></div>;
  if (!data || !layout) return <div className="empty-view">Loading…</div>;
  const qr = pageQrFor(ws, report);
  return (
    <DesignedReport
      report={{ ...report, layout }}
      data={data}
      doc={ws.doc}
      imageUrl={ws.imageUrl}
      pageQr={qr}
      toolbar={
        <>
          {qr?.note && <span className="report-note">{qr.note}</span>}
          <PublicLinkButton report={report} />
        </>
      }
    />
  );
}

/** Design View → QR code: a code printed in a corner of the report's page. */
export function PageQrSettings({ report, mutate }: { report: ReportDef; mutate: (fn: (o: FormDef & ReportDef) => void) => void }) {
  const ws = useWorkspace();
  const q = report.pageQr;
  const isPublic = usePublicLinks(ws.projectId).has(report.id);
  const set = (patch: Partial<NonNullable<ReportDef["pageQr"]>>) => mutate((o) => void (o.pageQr = { ...o.pageQr!, ...patch }));
  return (
    <div className="od-panel">
      <h3>QR code</h3>
      <label className="check-label">
        <input
          type="checkbox"
          checked={!!q}
          onChange={(e) =>
            mutate((o) => {
              if (e.target.checked) o.pageQr = { target: isPublic ? "public" : "app", size: 1, position: "top-right" };
              else delete o.pageQr;
            })
          }
        />
        Show a QR code on the page
      </label>
      {q && (
        <>
          <label>
            Opens
            <ComboBox
              className="text-input"
              value={q.target}
              ariaLabel="QR code opens"
              options={[
                { value: "public", label: `This report's public link (no sign-in)${isPublic ? "" : " (not public yet)"}` },
                { value: "app", label: "This report in Access Web (sign-in needed)" },
                { value: "url", label: "Another web address…" },
              ]}
              onChange={(v) => set({ target: v as "public" | "app" | "url" })}
            />
          </label>
          {q.target === "url" && (
            <label>
              Web address
              <input
                className="text-input"
                placeholder="https://example.org/event"
                defaultValue={q.url ?? ""}
                key={`u:${q.url}`}
                maxLength={500}
                onBlur={(e) => set({ url: e.target.value.trim() || undefined })}
              />
            </label>
          )}
          <div className="ls-grid">
            <label className="ls-field">
              Size
              <span className="ls-unit">
                <input
                  type="number"
                  step="0.1"
                  min={0.4}
                  max={4}
                  defaultValue={q.size}
                  key={`s:${q.size}`}
                  aria-label="QR code size in inches"
                  onBlur={(e) => set({ size: Math.max(0.4, Math.min(4, Number(e.target.value) || 1)) })}
                />
                in
              </span>
            </label>
            <label className="ls-field">
              Position
              <ComboBox
                className="text-input"
                value={q.position}
                ariaLabel="QR code position"
                options={[
                  { value: "top-right", label: "Top right" },
                  { value: "top-left", label: "Top left" },
                  { value: "bottom-right", label: "Bottom right" },
                  { value: "bottom-left", label: "Bottom left" },
                ]}
                onChange={(v) => set({ position: v as NonNullable<ReportDef["pageQr"]>["position"] })}
              />
            </label>
          </div>
          <label>
            Caption under it
            <input className="text-input" placeholder="e.g. Scan for the latest list" defaultValue={q.caption ?? ""} key={`c:${q.caption}`} maxLength={100} onBlur={(e) => set({ caption: e.target.value.trim() || undefined })} />
          </label>
          {q.target !== "url" && (
            <label title="The address phones open. Leave empty to use the address this app is open at.">
              Web address phones use
              <input className="text-input" placeholder={location.origin} defaultValue={q.baseUrl ?? ""} key={`b:${q.baseUrl}`} onBlur={(e) => set({ baseUrl: e.target.value.trim() || undefined })} />
            </label>
          )}
          <p className="muted small">
            {q.target === "public"
              ? isPublic
                ? "Anyone who scans the printed page sees the latest version of this report, without signing in."
                : "Make this report public (Report View → 🔗 Make public…) so the code has a link anyone can open."
              : q.target === "app"
                ? "Opens this report in Access Web; whoever scans signs in and needs access to this database."
                : "Opens the web address you type."}
          </p>
        </>
      )}
    </div>
  );
}
