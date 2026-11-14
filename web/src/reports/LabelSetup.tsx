/** Design View for a labels report: the sheet's measurements, the lines of text, and the QR code. */
import { usePublicLinks } from "./PublicReportDialog";
import type { LabelLayout, LabelLine, ReportDef } from "../../../shared/model";
import { ComboBox } from "../ui/ComboBox";
import { useSource } from "../views/FormReportViews";
import { useWorkspace } from "../workspace/context";
import { LABEL_PRESETS, PAGE_SIZES, fillTemplate, layoutProblem, linkKeyField } from "./labels";
import { LabelContent, labelBox } from "./LabelsView";

export function LabelSetup({ report }: { report: ReportDef }) {
  const ws = useWorkspace();
  const { data } = useSource(report.source);
  const l = report.labels!;
  const columns = data?.columns ?? [];

  const update = (fn: (l: LabelLayout, r: ReportDef) => void) =>
    ws.update((d) => {
      const r = d.reports.find((x) => x.id === report.id);
      if (r?.labels) fn(r.labels, r);
    });
  const setNum = (key: "width" | "height" | "marginTop" | "marginLeft" | "gapX" | "gapY" | "padding", v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return;
    update((x) => {
      x[key] = Math.round(n * 1000) / 1000;
      x.preset = "custom";
    });
  };
  const num = (key: "width" | "height" | "marginTop" | "marginLeft" | "gapX" | "gapY" | "padding", label: string, help: string) => (
    <label className="ls-field" title={help}>
      {label}
      <span className="ls-unit">
        <input type="number" step="0.01" min={0} defaultValue={l[key]} key={`${key}:${l[key]}`} onBlur={(e) => Number(e.target.value) !== l[key] && setNum(key, e.target.value)} />
        in
      </span>
    </label>
  );
  const setLine = (i: number, patch: Partial<LabelLine>) =>
    update((x) => {
      Object.assign(x.lines[i], patch);
    });
  const problem = layoutProblem(l);
  const first = data?.rows[0];
  const sources = [
    ...ws.doc.tables.map((t) => ({ value: `table:${t.id}`, label: `Table: ${t.name}` })),
    ...ws.doc.queries.map((q) => ({ value: `query:${q.id}`, label: `Query: ${q.name}` })),
  ];
  // Forms a QR code can open at the person: built on a table whose key is among these records' fields.
  const forms = ws.doc.forms.filter((f) => {
    if (f.source.kind !== "table") return false;
    if (report.source.kind === "table") return f.source.id === report.source.id;
    const key = linkKeyField(ws.doc, report.source, { kind: "form", formId: f.id });
    return !!key && !!data?.columns.some((c) => c.toLowerCase() === key.toLowerCase());
  });
  const keyField = linkKeyField(ws.doc, report.source, l.qr ? { kind: l.qr.target, formId: l.qr.formId } : undefined);
  const publicLinks = usePublicLinks(ws.projectId);
  const publicTarget = l.qr?.target === "public" ? ws.doc.reports.find((r) => r.id === l.qr!.publicReportId) : undefined;
  // The preview label is drawn at its real size, scaled down if it's very large.
  const scale = Math.min(1, 380 / (l.width * 96));

  return (
    <div className="object-design label-setup">
      <div className="od-panel">
        <h3>Labels</h3>
        <label className="ls-field">
          Title
          <input className="text-input" defaultValue={report.title} key={report.title} maxLength={200} onBlur={(e) => e.target.value !== report.title && update((_, r) => (r.title = e.target.value))} />
        </label>
        <label className="ls-field">
          Records from
          <ComboBox
            className="text-input"
            value={`${report.source.kind}:${report.source.id}`}
            ariaLabel="Record Source"
            options={sources}
            onChange={(v) => {
              const [k, id] = v.split(":");
              update((_, r) => (r.source = { kind: k as "table" | "query", id }));
            }}
          />
        </label>
        <label className="ls-field">
          Sort by
          <ComboBox
            className="text-input"
            value={report.sortBy ?? ""}
            ariaLabel="Sort By"
            options={[{ value: "", label: "(source order)" }, ...columns.map((c) => ({ value: c, label: c }))]}
            onChange={(v) => update((_, r) => (v ? (r.sortBy = v) : delete r.sortBy))}
          />
        </label>

        <h4>Sheet</h4>
        <label className="ls-field">
          Label product
          <ComboBox
            className="text-input"
            value={l.preset && LABEL_PRESETS.some((p) => p.id === l.preset) ? l.preset : "custom"}
            ariaLabel="Label product"
            options={[...LABEL_PRESETS.map((p) => ({ value: p.id, label: p.name })), { value: "custom", label: "Custom size" }]}
            onChange={(v) => {
              const p = LABEL_PRESETS.find((x) => x.id === v);
              update((x) => {
                x.preset = v;
                if (p) Object.assign(x, p.layout);
              });
            }}
          />
        </label>
        <label className="ls-field">
          Paper
          <ComboBox
            className="text-input"
            value={l.page}
            ariaLabel="Paper"
            options={(Object.keys(PAGE_SIZES) as LabelLayout["page"][]).map((k) => ({ value: k, label: PAGE_SIZES[k].label }))}
            onChange={(v) => update((x) => (x.page = v))}
          />
        </label>
        <div className="ls-grid">
          {num("width", "Label width", "Width of one label")}
          {num("height", "Label height", "Height of one label")}
          <label className="ls-field" title="Labels across the sheet">
            Across
            <input type="number" min={1} max={10} defaultValue={l.across} key={`a:${l.across}`} onBlur={(e) => update((x) => ((x.across = Math.max(1, Math.min(10, Math.round(Number(e.target.value)) || 1))), (x.preset = "custom")))} />
          </label>
          <label className="ls-field" title="Labels down the sheet">
            Down
            <input type="number" min={1} max={40} defaultValue={l.down} key={`d:${l.down}`} onBlur={(e) => update((x) => ((x.down = Math.max(1, Math.min(40, Math.round(Number(e.target.value)) || 1))), (x.preset = "custom")))} />
          </label>
          {num("marginTop", "Top margin", "From the top of the sheet to the first row of labels")}
          {num("marginLeft", "Left margin", "From the left edge of the sheet to the first column of labels")}
          {num("gapX", "Gap across", "Space between labels side by side")}
          {num("gapY", "Gap down", "Space between rows of labels")}
          {num("padding", "Inside margin", "Space between a label's edge and its text")}
          <label className="ls-field" title="Labels already used on a partly used sheet">
            Skip labels
            <input type="number" min={0} max={400} defaultValue={l.skip ?? 0} key={`s:${l.skip}`} onBlur={(e) => update((x) => (Number(e.target.value) > 0 ? (x.skip = Math.min(400, Math.round(Number(e.target.value)))) : delete x.skip))} />
          </label>
        </div>
        <label className="ls-check">
          <input type="checkbox" checked={!!l.outline} onChange={(e) => update((x) => (e.target.checked ? (x.outline = true) : delete x.outline))} />
          Print an outline around each label (for cutting, or a test print)
        </label>
        {problem && <div className="field-error">{problem}</div>}
      </div>

      <div className="od-panel">
        <h3>Text</h3>
        <p className="muted small">
          Type text and field names in brackets, like <code>[FirstName] [LastName]</code>. Click a field to add it to the line you were last in.
        </p>
        {l.lines.map((line, i) => (
          <div key={i} className="ls-line">
            <input
              className="text-input ls-line-text"
              defaultValue={line.text}
              key={`t${i}:${line.text}`}
              aria-label={`Line ${i + 1}`}
              data-line={i}
              onBlur={(e) => e.target.value !== line.text && setLine(i, { text: e.target.value })}
            />
            <input className="ls-size" type="number" min={5} max={96} defaultValue={line.size} key={`z${i}:${line.size}`} aria-label={`Line ${i + 1} size`} title="Size (points)" onBlur={(e) => setLine(i, { size: Math.max(5, Math.min(96, Number(e.target.value) || 12)) })} />
            <button className={`ls-toggle ${line.bold ? "on" : ""}`} title="Bold" aria-pressed={!!line.bold} onClick={() => setLine(i, { bold: !line.bold })}>
              <b>B</b>
            </button>
            <button className={`ls-toggle ${line.italic ? "on" : ""}`} title="Italic" aria-pressed={!!line.italic} onClick={() => setLine(i, { italic: !line.italic })}>
              <i>I</i>
            </button>
            <button className="ls-toggle" title="Remove line" aria-label={`Remove line ${i + 1}`} onClick={() => update((x) => void x.lines.splice(i, 1))}>
              ✕
            </button>
          </div>
        ))}
        <div className="button-row">
          <button disabled={l.lines.length >= 10} onClick={() => update((x) => void x.lines.push({ text: "", size: Math.max(8, Math.round((l.lines.at(-1)?.size ?? 14) * 0.7)) }))}>
            + Add line
          </button>
          <ComboBox
            className="text-input ls-align"
            value={l.align}
            ariaLabel="Alignment"
            options={[
              { value: "left", label: "Align left" },
              { value: "center", label: "Centered" },
              { value: "right", label: "Align right" },
            ]}
            onChange={(v) => update((x) => (x.align = v))}
          />
        </div>
        <div className="ls-fields">
          {columns.map((c) => (
            <button
              key={c}
              className="ls-chip"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                // Into the line that had the cursor (or the last line).
                const el = document.activeElement as HTMLInputElement | null;
                const i = el?.dataset.line !== undefined ? Number(el.dataset.line) : l.lines.length - 1;
                if (i < 0) return update((x) => void x.lines.push({ text: `[${c}]`, size: 14 }));
                setLine(i, { text: `${(el?.dataset.line !== undefined ? el.value : l.lines[i].text).trimEnd()} [${c}]`.trim() });
              }}
            >
              {c}
            </button>
          ))}
        </div>

        <h3>QR code</h3>
        <label className="ls-check">
          <input
            type="checkbox"
            checked={!!l.qr}
            onChange={(e) =>
              update((x) => {
                if (!e.target.checked) return void delete x.qr;
                const form = forms.find((f) => f.source.kind === report.source.kind && f.source.id === report.source.id);
                x.qr = { target: form ? "form" : "table", ...(form ? { formId: form.id } : {}), size: Math.min(1.2, Math.max(0.5, l.height - 2 * l.padding)), position: "right" };
              })
            }
          />
          Show a QR code that opens the person's record when scanned
        </label>
        {l.qr && (
          <>
            <label className="ls-field">
              Opens
              <ComboBox
                className="text-input"
                value={l.qr.target === "public" && l.qr.publicReportId ? `public:${l.qr.publicReportId}` : l.qr.target === "form" && l.qr.formId ? `form:${l.qr.formId}` : "table"}
                ariaLabel="QR code opens"
                options={[
                  ...ws.doc.reports.map((r) => ({
                    value: `public:${r.id}`,
                    label: `Public report: ${r.name}${publicLinks.has(r.id) ? "" : " (not public yet)"}`,
                  })),
                  ...forms.map((f) => ({ value: `form:${f.id}`, label: `Form: ${f.name} (sign-in needed)` })),
                  { value: "table", label: "The table (sign-in needed)" },
                ]}
                onChange={(v) =>
                  update(
                    (x) =>
                      (x.qr = {
                        ...x.qr!,
                        ...(v === "table"
                          ? { target: "table", formId: undefined, publicReportId: undefined }
                          : v.startsWith("public:")
                            ? { target: "public", formId: undefined, publicReportId: v.slice(7) }
                            : { target: "form", formId: v.slice(5), publicReportId: undefined }),
                      }),
                  )
                }
              />
            </label>
            <div className="ls-grid">
              <label className="ls-field">
                Size
                <span className="ls-unit">
                  <input type="number" step="0.05" min={0.4} max={4} defaultValue={l.qr.size} key={`q:${l.qr.size}`} onBlur={(e) => update((x) => (x.qr!.size = Math.max(0.4, Math.min(4, Number(e.target.value) || 1))))} />
                  in
                </span>
              </label>
              <label className="ls-field">
                Position
                <ComboBox
                  className="text-input"
                  value={l.qr.position}
                  ariaLabel="QR position"
                  options={[
                    { value: "right", label: "Right" },
                    { value: "left", label: "Left" },
                    { value: "bottom", label: "Below the text" },
                  ]}
                  onChange={(v) => update((x) => (x.qr!.position = v))}
                />
              </label>
            </div>
            <label className="ls-field" title="The address phones open. Leave empty to use the address this app is open at.">
              Web address phones use
              <input
                className="text-input"
                placeholder={location.origin}
                defaultValue={l.qr.baseUrl ?? ""}
                key={`b:${l.qr.baseUrl}`}
                onBlur={(e) => update((x) => (e.target.value.trim() ? (x.qr!.baseUrl = e.target.value.trim()) : delete x.qr!.baseUrl))}
              />
            </label>
            <p className="muted small">
              {l.qr.target === "public"
                ? publicTarget
                  ? publicLinks.has(publicTarget.id)
                    ? `Each code opens the public report "${publicTarget.name}" (no sign-in), highlighting that person${keyField ? ` by their ${keyField}` : ""}. A scan station (Home → Scan Tags) can also read these codes to record attendance or achievements.`
                    : `"${publicTarget.name}" isn't public yet. Open it and click 🔗 Make public…, then come back to print.`
                  : "Choose the public report the codes open."
                : keyField
                  ? `Each code opens that record by its ${keyField}. Whoever scans it signs in first and needs access to this database (or it must be published).`
                  : "QR codes need the table to have a primary key (or the query to include it)."}
            </p>
          </>
        )}
      </div>

      <div className="od-panel ls-preview-panel">
        <h3>Preview</h3>
        <p className="muted small">{first ? "The first record, at actual size." : "Add records to see a preview."}</p>
        {data && (
          <div className="ls-preview" style={{ width: `${l.width * scale}in`, height: `${l.height * scale}in` }}>
            <div className="label" style={{ ...labelBox(l, 0), left: 0, top: 0, transform: scale < 1 ? `scale(${scale})` : undefined, transformOrigin: "top left" }}>
              <LabelContent l={l} lines={l.lines.map((line) => (first ? fillTemplate(line.text, data.columns, data.fields, first) : line.text))} qr={l.qr ? `${location.origin}/?preview` : undefined} />
            </div>
          </div>
        )}
        <SheetDiagram l={l} />
      </div>
    </div>
  );
}

/** The whole sheet in miniature, so the margins and gaps are easy to see. */
function SheetDiagram({ l }: { l: LabelLayout }) {
  const page = PAGE_SIZES[l.page];
  const k = 22; // px per inch
  return (
    <svg className="ls-sheet" width={page.w * k} height={page.h * k} viewBox={`0 0 ${page.w} ${page.h}`} aria-label="Sheet layout">
      <rect width={page.w} height={page.h} fill="#fff" stroke="#999" strokeWidth={0.03} />
      {Array.from({ length: l.across * l.down }, (_, i) => (
        <rect
          key={i}
          x={l.marginLeft + (i % l.across) * (l.width + l.gapX)}
          y={l.marginTop + Math.floor(i / l.across) * (l.height + l.gapY)}
          width={l.width}
          height={l.height}
          rx={0.06}
          fill={i < (l.skip ?? 0) ? "#eee" : "#e8f0fb"}
          stroke="#5b8bd0"
          strokeWidth={0.02}
        />
      ))}
    </svg>
  );
}
