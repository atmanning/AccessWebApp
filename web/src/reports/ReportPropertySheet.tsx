/**
 * The Property Sheet in Report Design when no control is selected: the report's properties (record
 * source, page setup, width, Group, Sort, and Total, page QR code), or a section's (height, back
 * color, Force New Page, Keep Together, Visible) when its bar is clicked.
 */
import { useState } from "react";
import { PAGE_SIZES, type FormDef, type ReportDef, type ReportLayout } from "../../../shared/model";
import { BoolProp, ColorProp, Group, NumberProp, Row, Select, TextProp } from "../forms/FormPropertySheet";
import { useDialogs } from "../ui/dialogs";
import { PageQrSettings } from "../views/FormReportViews";
import { useWorkspace } from "../workspace/context";
import { newId } from "../workspace/docOps";
import { DPI, makeReportControl, PAGE_SIZE_INFO, pageSize, reportSections, sectionHeight, setSectionHeight } from "./reportLayout";

type Mutate = (fn: (l: ReportLayout, r: ReportDef) => void) => void;

/** A measurement in inches (two decimals). */
function InchProp({ value, min, max, onCommit, label }: { value: number; min: number; max: number; onCommit: (v: number) => void; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft);
    setDraft(null);
    if (Number.isFinite(v)) onCommit(Math.max(min, Math.min(max, Math.round(v * 100) / 100)));
  };
  return (
    <span className="ps-inch">
      <input
        className="ps-input num"
        aria-label={label}
        inputMode="decimal"
        value={draft ?? String(Math.round(value * 100) / 100)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      <span className="muted">in</span>
    </span>
  );
}

export function ReportPropertySheet(props: { report: ReportDef; layout: ReportLayout; section: string | null; fields: string[]; mutate: Mutate; onClose?: () => void }) {
  const { report, layout: l, section, fields, mutate } = props;
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const info = section ? reportSections(l).find((s) => s.key === section) : undefined;

  const header = (
    <div className="ps-head">
      <div>
        <div className="ps-kicker">Property Sheet</div>
        <div className="ps-title">{info ? `Section: ${info.label}` : `Report: ${report.name}`}</div>
      </div>
      {props.onClose && (
        <button className="icon-btn" aria-label="Close Property Sheet" onClick={props.onClose}>
          ✕
        </button>
      )}
    </div>
  );

  if (info) {
    const sp = l.sectionProps?.[info.key] ?? {};
    const setProp = (patch: Partial<NonNullable<ReportLayout["sectionProps"]>[string]>) =>
      mutate((x) => {
        const all = (x.sectionProps ??= {});
        const next = { ...all[info.key], ...patch };
        for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] === undefined || next[k] === false) delete next[k];
        if (Object.keys(next).length) all[info.key] = next;
        else delete all[info.key];
        if (!Object.keys(all).length) delete x.sectionProps;
      });
    const page = info.kind === "pageHeader" || info.kind === "pageFooter";
    return (
      <div className="prop-sheet">
        {header}
        <Group title="Format">
          <Row label="Height" hint="In pixels (96 per inch)">
            <NumberProp label="Height" value={sectionHeight(l, info.key)} min={info.kind === "groupHeader" || info.kind === "groupFooter" ? 1 : 0} max={info.max} onCommit={(v) => mutate((x) => setSectionHeight(x, info.key, v ?? 0))} />
          </Row>
          <Row label="Back Color">
            <ColorProp label="Back Color" value={sp.backColor} onChange={(v) => setProp({ backColor: v })} />
          </Row>
          <Row label="Visible">
            <BoolProp label="Visible" value={!sp.hidden} onChange={(b) => setProp({ hidden: !b || undefined })} />
          </Row>
          {!page && (
            <Row label="Force New Page" hint="Start a new page before or after this section prints">
              <Select
                label="Force New Page"
                value={sp.forceNewPage ?? ""}
                options={[
                  { value: "", label: "None" },
                  { value: "before", label: "Before Section" },
                  { value: "after", label: "After Section" },
                ]}
                onChange={(v) => setProp({ forceNewPage: (v || undefined) as "before" | "after" | undefined })}
              />
            </Row>
          )}
          {info.group && (
            <Row label="Keep Together" hint="Keep the whole group on one page when it fits">
              <BoolProp label="Keep Together" value={!!info.group.keepTogether} onChange={(b) => mutate((x) => void (x.groups.find((g) => g.id === info.group!.id)!.keepTogether = b || undefined))} />
            </Row>
          )}
        </Group>
        <p className="ps-tip">Drag the bar under a section to change its height. Group headers and footers are added in the report's Group, Sort, and Total (click the grey area).</p>
      </div>
    );
  }

  const ps = pageSize(l);
  const sources = [
    ...ws.doc.tables.map((t) => ({ value: `table:${t.id}`, label: `Table: ${t.name}` })),
    ...ws.doc.queries.map((q) => ({ value: `query:${q.id}`, label: `Query: ${q.name}` })),
  ];
  const fieldOptions = fields.map((f) => ({ value: f, label: f }));
  const setMargin = (k: keyof ReportLayout["page"]["margins"], v: number) => mutate((x) => void (x.page.margins[k] = v));

  /** Header or footer of a group on or off (off deletes its controls, after asking). */
  const toggleBand = async (gid: string, which: "header" | "footer", on: boolean) => {
    const key = `${which === "header" ? "gh" : "gf"}:${gid}`;
    const count = l.controls.filter((c) => c.section === key).length;
    if (!on && count) {
      const ok = await dialogs.confirm("Microsoft Access Web", `The group ${which} has ${count} control(s). Remove the ${which} and its controls? (Undo, Ctrl+Z, brings them back.)`, { okLabel: "Remove", danger: true });
      if (!ok) return;
    }
    mutate((x) => {
      const g = x.groups.find((y) => y.id === gid);
      if (!g) return;
      g[which] = on ? 36 : 0;
      if (!on) x.controls = x.controls.filter((c) => c.section !== key);
      else if (which === "header" && !x.controls.some((c) => c.section === key)) {
        x.controls.push(makeReportControl(x, "textbox", { section: key, x: 0, y: 6, w: Math.min(360, x.width), h: 24 }, { field: g.field, bold: true, fontSize: 16 }));
      }
    });
  };
  const removeGroup = async (gid: string) => {
    const count = l.controls.filter((c) => c.section === `gh:${gid}` || c.section === `gf:${gid}`).length;
    if (count) {
      const ok = await dialogs.confirm("Microsoft Access Web", `Remove this group and the ${count} control(s) in its header and footer? (Undo, Ctrl+Z, brings them back.)`, { okLabel: "Remove", danger: true });
      if (!ok) return;
    }
    mutate((x) => {
      x.groups = x.groups.filter((g) => g.id !== gid);
      x.controls = x.controls.filter((c) => c.section !== `gh:${gid}` && c.section !== `gf:${gid}`);
      if (x.sectionProps) {
        delete x.sectionProps[`gh:${gid}`];
        delete x.sectionProps[`gf:${gid}`];
      }
    });
  };
  const move = <T,>(arr: T[], i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  };

  return (
    <div className="prop-sheet">
      {header}
      <Group title="Format">
        <Row label="Caption">
          <TextProp label="Caption" value={report.title} onCommit={(v) => mutate((_, r) => void (r.title = v.slice(0, 200)))} />
        </Row>
        <Row label="Width" hint="Width of the report's sections">
          <InchProp label="Width" value={l.width / DPI} min={0.5} max={47} onCommit={(v) => mutate((x) => void (x.width = Math.max(x.controls.reduce((m, c) => Math.max(m, c.x + c.w), 48), Math.round(v * DPI))))} />
        </Row>
        <Row label="Font Size" hint="For controls without their own size (pixels)">
          <NumberProp label="Font Size" value={l.fontSize ?? 14} min={8} max={72} onCommit={(v) => mutate((x) => void (v && v !== 14 ? (x.fontSize = v) : delete x.fontSize))} />
        </Row>
      </Group>
      <div id="rp-page" />
      <Group title="Page Setup">
        <Row label="Paper Size">
          <Select label="Paper Size" value={l.page.size} options={PAGE_SIZES.map((s) => ({ value: s, label: PAGE_SIZE_INFO[s].label }))} onChange={(v) => mutate((x) => void (x.page.size = v))} />
        </Row>
        {l.page.size === "custom" && (
          <>
            <Row label="Paper Width">
              <InchProp label="Paper Width" value={l.page.width ?? 8.5} min={1} max={48} onCommit={(v) => mutate((x) => void (x.page.width = v))} />
            </Row>
            <Row label="Paper Height">
              <InchProp label="Paper Height" value={l.page.height ?? 11} min={1} max={48} onCommit={(v) => mutate((x) => void (x.page.height = v))} />
            </Row>
          </>
        )}
        <Row label="Orientation">
          <Select
            label="Orientation"
            value={l.page.landscape ? "landscape" : "portrait"}
            options={[
              { value: "portrait", label: "Portrait" },
              { value: "landscape", label: "Landscape" },
            ]}
            onChange={(v) => mutate((x) => void (v === "landscape" ? (x.page.landscape = true) : delete x.page.landscape))}
          />
        </Row>
        {(["top", "bottom", "left", "right"] as const).map((k) => (
          <Row key={k} label={`${k[0].toUpperCase()}${k.slice(1)} Margin`}>
            <InchProp label={`${k} margin`} value={l.page.margins[k]} min={0} max={4} onCommit={(v) => setMargin(k, v)} />
          </Row>
        ))}
        <p className={`ps-note small ${l.width > ps.printableW * DPI + 1 ? "warn" : ""}`}>
          Printable width {ps.printableW.toFixed(2)}″; the report is {(l.width / DPI).toFixed(2)}″ wide
          {l.width > ps.printableW * DPI + 1 ? ", so its right side won't fit. Make it narrower, or use smaller margins or landscape." : "."}
        </p>
        {l.width < ps.printableW * DPI - 24 && (
          <button className="ps-small-btn" onClick={() => mutate((x) => void (x.width = Math.round(ps.printableW * DPI)))}>
            Fit width to the page
          </button>
        )}
      </Group>
      <div id="rp-grouping" />
      <Group title="Group, Sort, and Total">
        {l.groups.map((g, i) => (
          <div key={g.id} className="rp-level">
            <div className="rp-level-head">
              <strong>Group on</strong>
              <Select label={`Group ${i + 1} field`} value={g.field} options={fields.includes(g.field) ? fieldOptions : [...fieldOptions, { value: g.field, label: `${g.field} (not in source)` }]} onChange={(v) => mutate((x) => void (x.groups[i].field = v))} />
              <span className="rp-level-btns">
                <button className="icon-btn" aria-label="Move group up" disabled={i === 0} onClick={() => mutate((x) => move(x.groups, i, -1))}>
                  ▲
                </button>
                <button className="icon-btn" aria-label="Move group down" disabled={i === l.groups.length - 1} onClick={() => mutate((x) => move(x.groups, i, 1))}>
                  ▼
                </button>
                <button className="icon-btn" aria-label="Remove group" onClick={() => void removeGroup(g.id)}>
                  ✕
                </button>
              </span>
            </div>
            <div className="rp-level-opts">
              <Select
                label="Sort order"
                value={g.descending ? "desc" : "asc"}
                options={[
                  { value: "asc", label: "A → Z (smallest first)" },
                  { value: "desc", label: "Z → A (largest first)" },
                ]}
                onChange={(v) => mutate((x) => void (v === "desc" ? (x.groups[i].descending = true) : delete x.groups[i].descending))}
              />
              <label className="check-label">
                <input type="checkbox" checked={g.header > 0} onChange={(e) => void toggleBand(g.id, "header", e.target.checked)} /> Header
              </label>
              <label className="check-label">
                <input type="checkbox" checked={g.footer > 0} onChange={(e) => void toggleBand(g.id, "footer", e.target.checked)} /> Footer
              </label>
              <label className="check-label" title="Keep the whole group on one page when it fits">
                <input type="checkbox" checked={!!g.keepTogether} onChange={(e) => mutate((x) => void (e.target.checked ? (x.groups[i].keepTogether = true) : delete x.groups[i].keepTogether))} /> Keep together
              </label>
            </div>
          </div>
        ))}
        {l.sorts.map((s, i) => (
          <div key={i} className="rp-level">
            <div className="rp-level-head">
              <strong>Sort by</strong>
              <Select label={`Sort ${i + 1} field`} value={s.field} options={fields.includes(s.field) ? fieldOptions : [...fieldOptions, { value: s.field, label: `${s.field} (not in source)` }]} onChange={(v) => mutate((x) => void (x.sorts[i].field = v))} />
              <span className="rp-level-btns">
                <button className="icon-btn" aria-label="Move sort up" disabled={i === 0} onClick={() => mutate((x) => move(x.sorts, i, -1))}>
                  ▲
                </button>
                <button className="icon-btn" aria-label="Move sort down" disabled={i === l.sorts.length - 1} onClick={() => mutate((x) => move(x.sorts, i, 1))}>
                  ▼
                </button>
                <button className="icon-btn" aria-label="Remove sort" onClick={() => mutate((x) => void x.sorts.splice(i, 1))}>
                  ✕
                </button>
              </span>
            </div>
            <div className="rp-level-opts">
              <Select
                label="Sort order"
                value={s.descending ? "desc" : "asc"}
                options={[
                  { value: "asc", label: "A → Z (smallest first)" },
                  { value: "desc", label: "Z → A (largest first)" },
                ]}
                onChange={(v) => mutate((x) => void (v === "desc" ? (x.sorts[i].descending = true) : delete x.sorts[i].descending))}
              />
            </div>
          </div>
        ))}
        <div className="rp-add">
          <button
            disabled={!fields.length || l.groups.length >= 10}
            onClick={() =>
              mutate((x) => {
                const id = newId("g");
                const field = fields.find((f) => !x.groups.some((g) => g.field === f)) ?? fields[0];
                x.groups.push({ id, field, header: 36, footer: 0 });
                x.controls.push(makeReportControl(x, "textbox", { section: `gh:${id}`, x: 0, y: 6, w: Math.min(360, x.width), h: 24 }, { field, bold: true, fontSize: 16 }));
              })
            }
          >
            + Add a group
          </button>
          <button disabled={!fields.length || l.sorts.length >= 10} onClick={() => mutate((x) => void x.sorts.push({ field: fields.find((f) => !x.sorts.some((s) => s.field === f)) ?? fields[0] }))}>
            + Add a sort
          </button>
        </div>
        <p className="ps-note small">
          Totals: put a text box such as <code>=Sum([Amount])</code>, <code>=Count(*)</code> or <code>=Avg([Score])</code> in a group footer (totals for the group) or the report
          footer (for the whole report). Page numbers: <code>="Page " &amp; [Page] &amp; " of " &amp; [Pages]</code>.
        </p>
      </Group>
      <Group title="Data">
        <Row label="Record Source">
          <Select
            label="Record Source"
            value={`${report.source.kind}:${report.source.id}`}
            options={sources}
            onChange={(v) => {
              const [k, id] = v.split(":");
              mutate((_, r) => void (r.source = { kind: k as "table" | "query", id }));
            }}
          />
        </Row>
      </Group>
      <div className="rp-qr">
        <PageQrSettings report={report} mutate={(fn) => mutate((_, r) => fn(r as FormDef & ReportDef))} />
      </div>
      <p className="ps-tip">Click a control to see its properties, or a section's bar for the section's. Shift+click or drag around controls to select several.</p>
    </div>
  );
}
