import { useEffect, useMemo, useState, type ReactNode } from "react";
import { PublicLinkButton } from "../reports/PublicReportDialog";
import { QrCode } from "../reports/QrCode";
import { pageQrFor, type PageQr } from "../reports/pageQr";
import { usePublicLinks } from "../reports/PublicReportDialog";
import type { CellValue, FormDef, ReportDef, SourceRef } from "../../../shared/model";
import { readSource, type ResultSet } from "../engine/engine";
import { formatValue, isNumericType } from "../engine/values";
import { ComboBox } from "../ui/ComboBox";
import { useCommands, useWorkspace } from "../workspace/context";

/** Loads a form/report's record source; tables are read synchronously so edits show instantly. */
export function useSource(source: SourceRef) {
  const ws = useWorkspace();
  const [queryResult, setQueryResult] = useState<{ data?: ResultSet; error?: string }>({});
  const table = source.kind === "table" ? ws.doc.tables.find((t) => t.id === source.id) : undefined;

  useEffect(() => {
    if (source.kind !== "query") return;
    let cancelled = false;
    readSource(ws.doc, source)
      .then((data) => !cancelled && setQueryResult({ data }))
      .catch((e: Error) => !cancelled && setQueryResult({ error: e.message }));
    return () => {
      cancelled = true;
    };
  }, [ws.doc, source.kind, source.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const tableData = useMemo<ResultSet | undefined>(
    () =>
      table && {
        columns: table.fields.map((f) => f.name),
        fields: table.fields,
        rows: table.rows.map((r) => table.fields.map((f) => r[f.id] ?? null)),
      },
    [table],
  );

  if (source.kind === "table") {
    return table ? { data: tableData, table } : { error: "The table this object is based on was deleted." };
  }
  return { ...queryResult, table: undefined };
}

export function ReportView({ report, tabKey }: { report: ReportDef; tabKey: string }) {
  const { data, error } = useSource(report.source);
  const ws = useWorkspace();
  useCommands(tabKey, { print: () => window.print() });
  // Redraw when public links load (a page QR code to this report's public link needs it).
  usePublicLinks(ws.projectId);
  if (error) return <div className="query-error"><strong>This report can't open.</strong><p>{error}</p></div>;
  if (!data) return <div className="empty-view">Loading…</div>;
  const qr = pageQrFor(ws, report);
  return (
    <ReportBody
      report={report}
      data={data}
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

/** A list report drawn from its data: in the app, and on a public report link. */
export function ReportBody({
  report,
  data,
  imageUrl,
  toolbar,
  highlight,
  pageQr,
}: {
  report: ReportDef;
  data: ResultSet;
  imageUrl: (id: string) => string;
  toolbar?: ReactNode;
  /** Rows to pick out (a public report opened from someone's name tag). */
  highlight?: (row: CellValue[]) => boolean;
  /** A QR code printed in a corner of the page. */
  pageQr?: PageQr | null;
}) {
  const prepared = useMemo(() => {
    const idx = (n?: string) => (n ? data.columns.findIndex((c) => c.toLowerCase() === n.toLowerCase()) : -1);
    const cols = report.columns.map((name) => ({ name, i: idx(name) })).filter((c) => c.i >= 0);
    const g = idx(report.groupBy);
    const s = idx(report.sortBy);
    const rows = [...data.rows];
    const cmp = (a: CellValue, b: CellValue) =>
      typeof a === "number" && typeof b === "number" ? a - b : String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
    rows.sort((a, b) => (g >= 0 ? cmp(a[g], b[g]) : 0) || (s >= 0 ? cmp(a[s], b[s]) : 0));
    const groups: { key: CellValue; rows: CellValue[][] }[] = [];
    if (g < 0) groups.push({ key: null, rows });
    else {
      for (const r of rows) {
        const last = groups[groups.length - 1];
        if (last && last.key === r[g]) last.rows.push(r);
        else groups.push({ key: r[g], rows: [r] });
      }
    }
    return { cols: cols.filter((c) => c.i !== g), groupField: g >= 0 ? data.fields[g] : undefined, groups, total: rows.length };
  }, [data, report]);

  const sumOf = (rows: CellValue[][], i: number) => rows.reduce<number>((acc, r) => acc + (typeof r[i] === "number" ? (r[i] as number) : 0), 0);
  const summable = (i: number) => {
    const t = data.fields[i]?.type;
    return t === "Currency" || (t === "Number" && !/id$/i.test(data.columns[i]));
  };
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  return (
    <div className="report-view">
      {toolbar && <div className="report-toolbar">{toolbar}</div>}
      <div className="report-page printable">
        {pageQr?.link && (
          <div className={`report-qr ${pageQr.position}`} style={{ width: `${pageQr.size}in` }}>
            <QrCode text={pageQr.link} size={`${pageQr.size}in`} title={pageQr.caption || "Scan to open"} />
            {pageQr.caption && <div className="report-qr-caption">{pageQr.caption}</div>}
          </div>
        )}
        <div
          className="report-header"
          style={
            pageQr?.link && pageQr.position.startsWith("top")
              ? { [pageQr.position === "top-right" ? "paddingRight" : "paddingLeft"]: `${pageQr.size + 0.15}in`, minHeight: `${pageQr.size}in` }
              : undefined
          }
        >
          <h1>{report.title || report.name}</h1>
          <div className="report-date">{today}</div>
        </div>
        <table className="report-table">
          <thead>
            <tr>
              {prepared.cols.map((c) => (
                <th key={c.name} className={isNumericType(data.fields[c.i]?.type) ? "num" : ""}>{c.name}</th>
              ))}
            </tr>
          </thead>
          {prepared.groups.map((grp, gi) => (
            <tbody key={gi}>
              {report.groupBy && (
                <tr className="group-header">
                  <td colSpan={prepared.cols.length}>
                    {report.groupBy}: <strong>{formatValue(prepared.groupField, grp.key) || "(blank)"}</strong>
                  </td>
                </tr>
              )}
              {grp.rows.map((r, ri) => (
                <tr key={ri} className={highlight?.(r) ? "highlight" : undefined} ref={highlight?.(r) ? (el) => el?.scrollIntoView({ block: "center" }) : undefined}>
                  {prepared.cols.map((c) => (
                    <td key={c.name} className={isNumericType(data.fields[c.i]?.type) ? "num" : ""}>
                      {data.fields[c.i]?.type === "Image" && r[c.i] ? (
                        <img className="report-img" src={imageUrl(String(r[c.i]))} alt="" loading="lazy" />
                      ) : (
                        formatValue(data.fields[c.i], r[c.i])
                      )}
                    </td>
                  ))}
                </tr>
              ))}
              {report.groupBy && (
                <tr className="group-footer">
                  {prepared.cols.map((c, ci) => (
                    <td key={c.name} className={isNumericType(data.fields[c.i]?.type) ? "num" : ""}>
                      {summable(c.i) ? formatValue(data.fields[c.i], sumOf(grp.rows, c.i)) : ci === 0 ? `${grp.rows.length} record(s)` : ""}
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          ))}
          <tfoot>
            <tr className="grand-total">
              {prepared.cols.map((c, ci) => (
                <td key={c.name} className={isNumericType(data.fields[c.i]?.type) ? "num" : ""}>
                  {summable(c.i)
                    ? formatValue(data.fields[c.i], prepared.groups.reduce((a, g) => a + sumOf(g.rows, c.i), 0))
                    : ci === 0
                      ? `Total: ${prepared.total} record(s)`
                      : ""}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
        <div
          className="report-footer"
          style={
            pageQr?.link && pageQr.position.startsWith("bottom")
              ? { minHeight: `${pageQr.size + (pageQr.caption ? 0.3 : 0.05)}in`, [pageQr.position === "bottom-right" ? "paddingRight" : "paddingLeft"]: `${pageQr.size + 0.15}in` }
              : undefined
          }
        >
          Page 1 of 1
        </div>
      </div>
    </div>
  );
}

/** Design view for forms and reports: record source, fields, grouping. */
export function FormReportDesign({ kind, obj }: { kind: "form" | "report"; obj: FormDef | ReportDef }) {
  const ws = useWorkspace();
  const { data } = useSource(obj.source);
  const available = data?.columns ?? [];

  const mutate = (fn: (o: FormDef & ReportDef) => void) =>
    ws.update((d) => {
      const list = (kind === "form" ? d.forms : d.reports) as (FormDef & ReportDef)[];
      fn(list.find((x) => x.id === obj.id)!);
    });

  const sources = [
    ...ws.doc.tables.map((t) => ({ value: `table:${t.id}`, label: `Table: ${t.name}` })),
    ...ws.doc.queries.map((q) => ({ value: `query:${q.id}`, label: `Query: ${q.name}` })),
  ];
  const report = kind === "report" ? (obj as ReportDef) : null;

  return (
    <div className="object-design">
      <div className="od-panel">
        <h3>Property Sheet</h3>
        <label>
          Caption / Title
          <input
            className="text-input"
            defaultValue={obj.title}
            key={obj.title}
            maxLength={200}
            onBlur={(e) => e.target.value !== obj.title && mutate((o) => (o.title = e.target.value))}
          />
        </label>
        <label>
          Record Source
          <ComboBox
            className="text-input"
            value={`${obj.source.kind}:${obj.source.id}`}
            ariaLabel="Record Source"
            options={sources}
            onChange={(v) => {
              const [k, id] = v.split(":");
              // Fields are kept; any the new source lacks are flagged "(not in source)" below.
              mutate((o) => {
                o.source = { kind: k as "table" | "query", id };
              });
            }}
          />
        </label>
        {report && (
          <>
            <label>
              Group On
              <ComboBox
                className="text-input"
                value={report.groupBy ?? ""}
                ariaLabel="Group On"
                options={[{ value: "", label: "(no grouping)" }, ...available.map((c) => ({ value: c, label: c }))]}
                onChange={(v) => mutate((o) => (v ? (o.groupBy = v) : delete o.groupBy))}
              />
            </label>
            <label>
              Sort By
              <ComboBox
                className="text-input"
                value={report.sortBy ?? ""}
                ariaLabel="Sort By"
                options={[{ value: "", label: "(source order)" }, ...available.map((c) => ({ value: c, label: c }))]}
                onChange={(v) => mutate((o) => (v ? (o.sortBy = v) : delete o.sortBy))}
              />
            </label>
          </>
        )}
      </div>
      {report && <PageQrSettings report={report} mutate={mutate} />}
      <div className="od-panel">
        <h3>Fields on this {kind}</h3>
        <p className="muted small">Tick fields to show them. Use the arrows to change their order.</p>
        <ul className="field-picker">
          {[...obj.columns, ...available.filter((c) => !obj.columns.includes(c))].map((c) => {
            const on = obj.columns.includes(c);
            const i = obj.columns.indexOf(c);
            const missing = !available.includes(c);
            return (
              <li key={c} className={missing ? "missing" : ""}>
                <label>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => mutate((o) => (o.columns = on ? o.columns.filter((x) => x !== c) : [...o.columns, c]))}
                  />
                  {c} {missing && <em>(not in source)</em>}
                </label>
                {on && (
                  <span className="order-btns">
                    <button className="icon-btn" disabled={i === 0} aria-label={`Move ${c} up`} onClick={() => mutate((o) => { [o.columns[i - 1], o.columns[i]] = [o.columns[i], o.columns[i - 1]]; })}>▲</button>
                    <button className="icon-btn" disabled={i === obj.columns.length - 1} aria-label={`Move ${c} down`} onClick={() => mutate((o) => { [o.columns[i + 1], o.columns[i]] = [o.columns[i], o.columns[i + 1]]; })}>▼</button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** Design View → QR code: a code printed in a corner of the report's page. */
function PageQrSettings({ report, mutate }: { report: ReportDef; mutate: (fn: (o: FormDef & ReportDef) => void) => void }) {
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
