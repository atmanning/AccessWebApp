/**
 * Report Design View, like Access's: the report's sections (Report Header, Page Header, a header and
 * footer per group, Detail, Page Footer, Report Footer) on a canvas. Add controls from the toolbox
 * or fields from the field list; move, resize, align and format them; resize sections; click a
 * section's bar for its properties, or the canvas for the report's (page setup, grouping and
 * sorting). A dashed line shows where the paper's printable width ends.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { REPORT_CONTROL_TYPES, type FormControl, type FormControlType, type FormDef, type ReportControl, type ReportDef, type ReportLayout } from "../../../shared/model";
import { CONTROL_ICONS, FieldListIcon, PropertySheetIcon } from "../forms/formIcons";
import { CONTROL_LABELS, GRID, snap } from "../forms/formLayout";
import { FormPropertySheet } from "../forms/FormPropertySheet";
import { useLayout, useLongPress } from "../ui/layout";
import { ControlMenu } from "../ui/ControlMenu";
import { useDialogs } from "../ui/dialogs";
import { FontStyleDialog, textOf } from "../ui/FontStyleDialog";
import { useSource } from "../views/FormReportViews";
import { useCommands, useWorkspace } from "../workspace/context";
import { newId } from "../workspace/docOps";
import { ReportControlView } from "./ReportControlView";
import { ReportPropertySheet } from "./ReportPropertySheet";
import { DPI, makeReportControl, pageSize, reportSections, sectionHeight, setSectionHeight, syncReportColumns, wizardLayout } from "./reportLayout";

type Rect = { x: number; y: number; w: number; h: number };
type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
type Preview =
  | { kind: "move"; ids: string[]; dx: number; dy: number }
  | { kind: "resize"; id: string; rect: Rect }
  | { kind: "marquee"; rect: Rect }
  | { kind: "place"; section: string; rect: Rect }
  | { kind: "section"; section: string; h: number }
  | { kind: "width"; w: number };

let clipboard: ReportControl[] | null = null;
const DT_FIELD = "application/x-accessweb-field";
const DT_CONTROL = "application/x-accessweb-control";
const MAX_W = 4600;

function track(e: RPointerEvent, onMove: (dx: number, dy: number, ev: PointerEvent) => void, onUp: (dx: number, dy: number, ev: PointerEvent) => void) {
  const x0 = e.clientX;
  const y0 = e.clientY;
  const move = (ev: PointerEvent) => onMove(ev.clientX - x0, ev.clientY - y0, ev);
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    onUp(ev.clientX - x0, ev.clientY - y0, ev);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}
const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const normRect = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });

export function ReportDesigner({ report, tabKey }: { report: ReportDef; tabKey: string }) {
  const ws = useWorkspace();
  const { compact, touch } = useLayout();
  const { data } = useSource(report.source);
  const fields = useMemo(() => (data ? data.columns.map((name, i) => ({ name, field: data.fields[i] })) : []), [data]);
  // Reports made before Report Design get a Report Wizard layout from their fields (saved on the first change).
  const layout = useMemo(() => report.layout ?? wizardLayout(report, fields), [report, fields]);
  const [sel, setSel] = useState<string[]>([]);
  const [section, setSection] = useState<string | null>(null);
  const [tool, setTool] = useState<FormControlType | null>(null);
  const [showFields, setShowFields] = useState(!compact);
  const [showProps, setShowProps] = useState(!compact);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const readOnly = ws.readOnly;
  const sections = reportSections(layout);

  useEffect(() => {
    setSel((s) => (s.every((id) => layout.controls.some((c) => c.id === id)) ? s : s.filter((id) => layout.controls.some((c) => c.id === id))));
    if (section && !sections.some((x) => x.key === section)) setSection(null);
  }, [layout]); // eslint-disable-line react-hooks/exhaustive-deps

  const byId = (id: string) => layout.controls.find((c) => c.id === id);
  const selected = sel.map(byId).filter((c): c is ReportControl => !!c);

  /** Changes the layout (saving a generated one the first time). One call = one undo step. */
  const mutate = (fn: (l: ReportLayout, r: ReportDef) => void) => {
    if (readOnly) return ws.setStatus("This database is read-only.", "error");
    ws.update((d) => {
      const r = d.reports.find((x) => x.id === report.id);
      if (!r) return;
      if (!r.layout) r.layout = structuredClone(layout);
      fn(r.layout, r);
      syncReportColumns(r);
    });
  };
  const contentBottom = (l: ReportLayout, key: string) => l.controls.filter((c) => c.section === key).reduce((m, c) => Math.max(m, c.y + c.h), 0);
  /** Grows sections and the report so every control fits. */
  const fitSections = (l: ReportLayout) => {
    for (const s of reportSections(l)) {
      const bottom = contentBottom(l, s.key);
      if (bottom > sectionHeight(l, s.key)) setSectionHeight(l, s.key, Math.min(s.max, snap(bottom + GRID / 2)));
    }
    const right = l.controls.reduce((m, c) => Math.max(m, c.x + c.w), 0);
    if (right > l.width) l.width = Math.min(MAX_W, snap(right));
  };
  const patchSelected = (patch: Partial<ReportControl>, ids = sel) =>
    mutate((l) => {
      for (const c of l.controls) {
        if (!ids.includes(c.id)) continue;
        Object.assign(c, patch);
        for (const k of Object.keys(patch) as (keyof ReportControl)[]) if (patch[k] === undefined) delete c[k];
      }
      fitSections(l);
    });

  // ---- Geometry ------------------------------------------------------------------------------
  const sectionTops = () => {
    const base = formRef.current!.getBoundingClientRect();
    const out: Record<string, number> = {};
    for (const s of sections) out[s.key] = (sectionRefs.current[s.key]?.getBoundingClientRect().top ?? base.top) - base.top;
    return out;
  };
  const toForm = (cx: number, cy: number) => {
    const r = formRef.current!.getBoundingClientRect();
    return { x: cx - r.left, y: cy - r.top };
  };
  const sectionAt = (y: number, tops: Record<string, number>): string => {
    let best = "detail";
    let bestDist = Infinity;
    for (const s of sections) {
      const h = s.height;
      if (h <= 0) continue;
      const top = tops[s.key];
      if (y >= top && y < top + h) return s.key;
      const d = Math.min(Math.abs(y - top), Math.abs(y - (top + h)));
      if (d < bestDist) {
        bestDist = d;
        best = s.key;
      }
    }
    return best;
  };

  // ---- Adding controls -----------------------------------------------------------------------
  const addControls = (make: (l: ReportLayout) => ReportControl[], opts: { edit?: boolean } = {}) => {
    let ids: string[] = [];
    mutate((l) => {
      const made = make(l);
      l.controls.push(...made);
      ids = made.map((c) => c.id);
      fitSections(l);
    });
    setSel(ids.slice(-1));
    setSection(null);
    setTool(null);
    if (opts.edit && ids.length === 1) setEditing(ids[0]);
    canvasRef.current?.focus({ preventScroll: true });
  };
  const nextSpot = (l: ReportLayout) => {
    const used = l.controls.filter((c) => c.section === "detail");
    const right = used.reduce((m, c) => Math.max(m, c.x + c.w), 0);
    return right + 170 <= l.width ? { section: "detail", x: snap(right + 8), y: 2 } : { section: "detail", x: 0, y: snap(contentBottom(l, "detail") + 4) };
  };
  /** A field: a text box (a check box for Yes/No, a picture for Image) with its name as a heading. */
  const addField = (name: string, at?: { section: string; x: number; y: number }) =>
    addControls((l) => {
      const fd = fields.find((f) => f.name === name)?.field;
      const spot = at ?? nextSpot(l);
      const type: FormControlType = fd?.type === "YesNo" ? "checkbox" : fd?.type === "Image" ? "image" : "textbox";
      const numeric = fd?.type === "Currency" || fd?.type === "Number";
      const box = makeReportControl(l, type, spot, { field: name, ...(numeric ? { align: "right" as const } : {}) });
      const out: ReportControl[] = [];
      // Its heading: in the page header above it (a list), or beside it in other sections.
      const tmp = { ...l, controls: [...l.controls, box] };
      if (spot.section === "detail" && l.sections.pageHeader > 0) {
        out.push(makeReportControl(tmp, "label", { section: "pageHeader", x: spot.x, y: Math.max(0, Math.min(l.sections.pageHeader - 24, 6)) }, { caption: name, bold: true, w: box.w, name: `${name}_Label`, ...(numeric ? { align: "right" as const } : {}) }));
      } else if (spot.section !== "pageHeader" && spot.section !== "pageFooter") {
        out.push(makeReportControl(tmp, "label", { section: spot.section, x: Math.max(0, spot.x - 128), y: spot.y }, { caption: name, w: 120, name: `${name}_Label` }));
      }
      out.push(box);
      return out;
    });
  const addTool = (type: FormControlType, at?: { section: string; x: number; y: number; w?: number; h?: number }) =>
    addControls((l) => [makeReportControl(l, type, at ?? nextSpot(l))], { edit: type === "label" });

  const dropAt = (e: DragEvent) => {
    const f = e.dataTransfer.getData(DT_FIELD);
    const t = e.dataTransfer.getData(DT_CONTROL) as FormControlType;
    if (!f && !t) return;
    e.preventDefault();
    const p = toForm(e.clientX, e.clientY);
    const tops = sectionTops();
    const s = sectionAt(p.y, tops);
    const at = { section: s, x: snap(Math.max(0, p.x - 12)), y: snap(Math.max(0, p.y - tops[s] - 8)) };
    if (f) addField(f, at);
    else if ((REPORT_CONTROL_TYPES as readonly string[]).includes(t)) addTool(t, at);
  };

  // ---- Pointer gestures ----------------------------------------------------------------------
  const onControlDown = (e: RPointerEvent, c: ReportControl) => {
    if (e.button !== 0 || editing === c.id) return;
    e.stopPropagation();
    canvasRef.current?.focus({ preventScroll: true });
    setSection(null);
    if (tool) return onSectionDown(e, c.section);
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      setSel((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id]));
      return;
    }
    const wasSelected = sel.includes(c.id);
    const ids = wasSelected ? sel : [c.id];
    if (!wasSelected) setSel(ids);
    if (readOnly) return;
    let moved = false;
    track(
      e,
      (dx, dy, ev) => {
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        setPreview({ kind: "move", ids, dx: snap(dx, !ev.altKey), dy: snap(dy, !ev.altKey) });
      },
      (dx, dy, ev) => {
        setPreview(null);
        if (!moved) {
          if (wasSelected && sel.length > 1) setSel([c.id]);
          return;
        }
        const ddx = snap(dx, !ev.altKey);
        const ddy = snap(dy, !ev.altKey);
        const tops = sectionTops();
        mutate((l) => {
          for (const ctl of l.controls) {
            if (!ids.includes(ctl.id)) continue;
            const absY = tops[ctl.section] + ctl.y + ddy;
            const s = sectionAt(absY + 1, tops);
            ctl.section = s;
            ctl.y = Math.max(0, Math.min(4000 - ctl.h, Math.round(absY - tops[s])));
            ctl.x = Math.max(0, Math.min(4000 - ctl.w, ctl.x + ddx));
          }
          fitSections(l);
        });
      },
    );
  };

  const onHandleDown = (e: RPointerEvent, c: ReportControl, h: Handle) => {
    e.stopPropagation();
    e.preventDefault();
    if (readOnly) return;
    const min = c.type === "line" ? 1 : 6;
    const calc = (dx: number, dy: number, on: boolean): Rect => {
      let { x, y, w, h: hh } = c;
      if (h.includes("e")) w = Math.max(min, snap(c.x + c.w + dx, on) - c.x);
      if (h.includes("s")) hh = Math.max(min, snap(c.y + c.h + dy, on) - c.y);
      if (h.includes("w")) {
        const nx = Math.min(c.x + c.w - min, Math.max(0, snap(c.x + dx, on)));
        w = c.x + c.w - nx;
        x = nx;
      }
      if (h.includes("n")) {
        const ny = Math.min(c.y + c.h - min, Math.max(0, snap(c.y + dy, on)));
        hh = c.y + c.h - ny;
        y = ny;
      }
      return { x, y, w, h: hh };
    };
    track(
      e,
      (dx, dy, ev) => setPreview({ kind: "resize", id: c.id, rect: calc(dx, dy, !ev.altKey) }),
      (dx, dy, ev) => {
        setPreview(null);
        const r = calc(dx, dy, !ev.altKey);
        if (r.x !== c.x || r.y !== c.y || r.w !== c.w || r.h !== c.h) patchSelected({ x: r.x, y: r.y, w: Math.min(4000, r.w), h: Math.min(4000, r.h) }, [c.id]);
      },
    );
  };

  const onSectionDown = (e: RPointerEvent, key: string) => {
    if (e.button !== 0) return;
    canvasRef.current?.focus({ preventScroll: true });
    setEditing(null);
    const start = toForm(e.clientX, e.clientY);
    const tops = sectionTops();
    if (tool) {
      e.preventDefault();
      const type = tool;
      const sy = start.y - tops[key];
      const local = (dx: number, dy: number, on: boolean) => {
        const r = normRect(start.x, sy, start.x + dx, sy + dy);
        return { x: snap(Math.max(0, r.x), on), y: snap(Math.max(0, r.y), on), w: snap(r.w, on), h: snap(r.h, on) };
      };
      track(
        e,
        (dx, dy, ev) => setPreview({ kind: "place", section: key, rect: local(dx, dy, !ev.altKey) }),
        (dx, dy, ev) => {
          setPreview(null);
          const r = local(dx, dy, !ev.altKey);
          const big = r.w >= GRID * 2 && r.h >= (type === "line" ? 1 : GRID * 2);
          addTool(type, big ? { section: key, ...r, h: type === "line" && r.h < GRID * 2 ? 2 : r.h } : { section: key, x: r.x, y: r.y });
        },
      );
      return;
    }
    if (e.pointerType === "touch") {
      setSel([]);
      setSection(key);
      return;
    }
    e.preventDefault();
    const keep = e.shiftKey || e.ctrlKey || e.metaKey ? sel : [];
    track(
      e,
      (dx, dy) => setPreview({ kind: "marquee", rect: normRect(start.x, start.y, start.x + dx, start.y + dy) }),
      (dx, dy) => {
        setPreview(null);
        const r = normRect(start.x, start.y, start.x + dx, start.y + dy);
        if (r.w < 3 && r.h < 3) {
          // A click on a section's empty space: that section's properties.
          setSel(keep);
          if (!keep.length) setSection(key);
          return;
        }
        setSection(null);
        const hit = layout.controls.filter((c) => intersects(r, { x: c.x, y: tops[c.section] + c.y, w: c.w, h: c.h })).map((c) => c.id);
        setSel([...new Set([...keep, ...hit])]);
      },
    );
  };

  const onSectionResize = (e: RPointerEvent, key: string, max: number) => {
    e.stopPropagation();
    e.preventDefault();
    if (readOnly) return;
    const h0 = sectionHeight(layout, key);
    const min = Math.max(key === "detail" ? 0 : 0, contentBottom(layout, key));
    const calc = (dy: number, on: boolean) => Math.min(max, Math.max(min, snap(h0 + dy, on)));
    track(
      e,
      (_, dy, ev) => setPreview({ kind: "section", section: key, h: calc(dy, !ev.altKey) }),
      (_, dy, ev) => {
        setPreview(null);
        const h = calc(dy, !ev.altKey);
        if (h !== h0) mutate((l) => setSectionHeight(l, key, h));
      },
    );
  };

  const onWidthResize = (e: RPointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (readOnly) return;
    const w0 = layout.width;
    const min = Math.max(48, layout.controls.reduce((m, c) => Math.max(m, c.x + c.w), 0));
    const calc = (dx: number, on: boolean) => Math.min(MAX_W, Math.max(min, snap(w0 + dx, on)));
    track(
      e,
      (dx, _, ev) => setPreview({ kind: "width", w: calc(dx, !ev.altKey) }),
      (dx, _, ev) => {
        setPreview(null);
        const w = calc(dx, !ev.altKey);
        if (w !== w0) mutate((l) => (l.width = w));
      },
    );
  };

  // ---- Commands --------------------------------------------------------------------------------
  const removeSelected = () => {
    if (!sel.length) return;
    const ids = sel;
    mutate((l) => (l.controls = l.controls.filter((c) => !ids.includes(c.id))));
    setSel([]);
  };
  const paste = (items: ReportControl[], offset: number) =>
    addControls((l) => {
      const out: ReportControl[] = [];
      for (const it of items) {
        const target = sections.some((s) => s.key === it.section) ? it.section : "detail";
        const c = makeReportControl({ ...l, controls: [...l.controls, ...out] }, it.type, { section: target, x: Math.min(4000 - it.w, it.x + offset), y: Math.min(4000 - it.h, it.y + offset) }, { ...structuredClone(it), id: undefined as never, name: it.name.replace(/\d+$/, "") || "Control", section: target });
        c.id = newId("c");
        out.push(c);
      }
      return out;
    });
  const align = (edge: "left" | "right" | "top" | "bottom") => {
    if (selected.length < 2) return;
    const v =
      edge === "left" ? Math.min(...selected.map((c) => c.x))
      : edge === "right" ? Math.max(...selected.map((c) => c.x + c.w))
      : edge === "top" ? Math.min(...selected.map((c) => c.y))
      : Math.max(...selected.map((c) => c.y + c.h));
    mutate((l) => {
      for (const c of l.controls) {
        if (!sel.includes(c.id)) continue;
        if (edge === "left") c.x = v;
        else if (edge === "right") c.x = Math.max(0, v - c.w);
        else if (edge === "top") c.y = v;
        else c.y = Math.max(0, v - c.h);
      }
      fitSections(l);
    });
  };
  const sameSize = (dim: "width" | "height") => {
    if (selected.length < 2) return;
    const v = dim === "width" ? Math.max(...selected.map((c) => c.w)) : Math.max(...selected.map((c) => c.h));
    patchSelected(dim === "width" ? { w: v } : { h: v });
  };
  const order = (where: "front" | "back") => {
    if (!sel.length) return;
    mutate((l) => {
      const moving = l.controls.filter((c) => sel.includes(c.id));
      const rest = l.controls.filter((c) => !sel.includes(c.id));
      l.controls = where === "front" ? [...rest, ...moving] : [...moving, ...rest];
    });
  };
  /** Header & Footer group of the ribbon: a text box in the right place, like Access's buttons. */
  const insert = (what: "pageNumbers" | "dateTime" | "title") =>
    addControls((l) => {
      if (what === "pageNumbers") {
        if (l.sections.pageFooter < 28) l.sections.pageFooter = 32;
        return [makeReportControl(l, "textbox", { section: "pageFooter", x: Math.max(0, l.width - 200), y: 6, w: 200, h: 20 }, { field: '="Page " & [Page] & " of " & [Pages]', align: "right", name: "PageNumbers" })];
      }
      if (l.sections.reportHeader < 48) l.sections.reportHeader = 56;
      if (what === "dateTime") return [makeReportControl(l, "textbox", { section: "reportHeader", x: Math.max(0, l.width - 220), y: 8, w: 220, h: 20 }, { field: "=Now()", format: "General Date", align: "right", name: "PrintedOn" })];
      return [makeReportControl(l, "label", { section: "reportHeader", x: 0, y: 6, w: Math.min(l.width, 480), h: 40 }, { caption: report.title || report.name, fontSize: 26, bold: true, name: "Title" })];
    });

  useCommands(tabKey, {
    formDesign: {
      tool,
      setTool: (t) => setTool((cur) => (cur === t ? null : t)),
      selectionCount: sel.length,
      align,
      sameSize,
      order,
      theme: "office",
      setTheme: () => {},
      fieldList: showFields,
      toggleFieldList: () => setShowFields((v) => !v),
      propertySheet: showProps,
      togglePropertySheet: () => setShowProps((v) => !v),
      relayout: () => {},
      remove: removeSelected,
      tabOrder: () => {},
      report: true,
      groupSort: () => {
        setSel([]);
        setSection(null);
        setShowProps(true);
        requestAnimationFrame(() => document.getElementById("rp-grouping")?.scrollIntoView({ block: "start" }));
      },
      pageSetup: () => {
        setSel([]);
        setSection(null);
        setShowProps(true);
        requestAnimationFrame(() => document.getElementById("rp-page")?.scrollIntoView({ block: "start" }));
      },
      insertPageNumbers: () => insert("pageNumbers"),
      insertDateTime: () => insert("dateTime"),
      insertTitle: () => insert("title"),
    },
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement) !== canvasRef.current) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (k === "Escape") {
      if (tool) setTool(null);
      else {
        setSel([]);
        setSection(null);
      }
      return;
    }
    if (mod && k.toLowerCase() === "a") {
      e.preventDefault();
      setSel(layout.controls.map((c) => c.id));
      return;
    }
    if (!sel.length) {
      if (mod && k.toLowerCase() === "v" && clipboard) {
        e.preventDefault();
        paste(clipboard, GRID * 2);
      }
      return;
    }
    if (k === "Delete" || k === "Backspace") {
      e.preventDefault();
      removeSelected();
    } else if (mod && k.toLowerCase() === "c") {
      e.preventDefault();
      clipboard = structuredClone(selected);
      ws.setStatus(`${selected.length} control${selected.length > 1 ? "s" : ""} copied.`);
    } else if (mod && k.toLowerCase() === "x") {
      e.preventDefault();
      clipboard = structuredClone(selected);
      removeSelected();
    } else if (mod && k.toLowerCase() === "v" && clipboard) {
      e.preventDefault();
      paste(clipboard, GRID * 2);
    } else if (mod && k.toLowerCase() === "d") {
      e.preventDefault();
      paste(selected, GRID * 2);
    } else if (k === "Enter" && selected.length === 1 && selected[0].type === "label") {
      e.preventDefault();
      setEditing(selected[0].id);
    } else if (k.startsWith("Arrow")) {
      e.preventDefault();
      const step = mod ? 1 : GRID;
      const dx = k === "ArrowLeft" ? -step : k === "ArrowRight" ? step : 0;
      const dy = k === "ArrowUp" ? -step : k === "ArrowDown" ? step : 0;
      mutate((l) => {
        for (const c of l.controls) {
          if (!sel.includes(c.id)) continue;
          if (e.shiftKey) {
            c.w = Math.max(c.type === "line" ? 1 : 6, Math.min(4000, c.w + dx));
            c.h = Math.max(c.type === "line" ? 1 : 6, Math.min(4000, c.h + dy));
          } else {
            c.x = Math.max(0, Math.min(4000 - c.w, c.x + dx));
            c.y = Math.max(0, Math.min(4000 - c.h, c.y + dy));
          }
        }
        fitSections(l);
      });
    }
  };

  // ---- Rendering -------------------------------------------------------------------------------
  const width = preview?.kind === "width" ? preview.w : layout.width;
  const hOf = (key: string, h: number) => (preview?.kind === "section" && preview.section === key ? preview.h : h);
  const rectOf = (c: ReportControl): Rect => (preview?.kind === "resize" && preview.id === c.id ? preview.rect : { x: c.x, y: c.y, w: c.w, h: c.h });
  const primary = selected.length ? selected[selected.length - 1] : null;
  const ps = pageSize(layout);
  const printableW = Math.round(ps.printableW * DPI);
  const baseFont = layout.fontSize ?? 14;
  const onReport = new Set(layout.controls.map((c) => c.field?.toLowerCase()).filter(Boolean));
  const commitCaption = (c: ReportControl, text: string) => {
    setEditing(null);
    if (text !== (c.caption ?? "")) patchSelected({ caption: text.slice(0, 500) }, [c.id]);
  };

  // A control's menu: a long press on a touch screen, or a right-click.
  const press = useLongPress();
  const dialogs = useDialogs();
  const [ctlMenu, setCtlMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const menuControl = ctlMenu ? layout.controls.find((c) => c.id === ctlMenu.id) : undefined;
  const openControlMenu = (c: ReportControl, x: number, y: number) => {
    if (readOnly) return;
    setSel([c.id]);
    setCtlMenu({ x, y, id: c.id });
  };
  const [styling, setStyling] = useState<string | null>(null);
  const styleControl = styling ? layout.controls.find((c) => c.id === styling) : undefined;
  /** Edit Text: a caption in place on the control; a text box's own label in a box. */
  const editText = async (c: ReportControl) => {
    const t = textOf(c);
    if (!t) return;
    if (t.key === "caption") return setEditing(c.id);
    const v = await dialogs.prompt("Edit Text", `The label for ${c.name}:`, t.value);
    if (v !== null && v !== t.value) patchSelected({ label: v.slice(0, 200) }, [c.id]);
  };
  const sourceName = ws.doc.tables.find((t) => t.id === report.source.id)?.name ?? ws.doc.queries.find((q) => q.id === report.source.id)?.name ?? "(missing)";

  const fieldPane = (
    <aside className="fd-pane fd-left">
      <div className="fd-pane-title">Controls</div>
      <div className="fd-toolbox" role="toolbar" aria-label="Controls">
        {REPORT_CONTROL_TYPES.map((t) => {
          const Icon = CONTROL_ICONS[t];
          return (
            <button
              key={t}
              className={`fd-tool ${tool === t ? "armed" : ""}`}
              aria-pressed={tool === t}
              draggable={!touch && !readOnly}
              onDragStart={(e) => e.dataTransfer.setData(DT_CONTROL, t)}
              onClick={() => setTool((cur) => (cur === t ? null : t))}
              disabled={readOnly}
              title={`${CONTROL_LABELS[t]}: click, then click or drag on the report${touch ? "" : " (or drag it onto the report)"}`}
            >
              <Icon size={20} />
              <span>{CONTROL_LABELS[t]}</span>
            </button>
          );
        })}
      </div>
      <div className="fd-pane-title">
        Fields
        <span className="fd-pane-sub">
          {report.source.kind === "table" ? "Table" : "Query"}: {sourceName}
        </span>
      </div>
      <ul className="fd-fields">
        {fields.map((f) => (
          <li key={f.name}>
            <button
              className={`fd-field ${onReport.has(f.name.toLowerCase()) ? "used" : ""}`}
              draggable={!touch && !readOnly}
              disabled={readOnly}
              onDragStart={(e) => e.dataTransfer.setData(DT_FIELD, f.name)}
              onClick={() => addField(f.name)}
              title={`Add ${f.name} to the Detail section${touch ? "" : " (or drag it to a spot in any section)"}`}
            >
              <span className="fd-field-name">{f.name}</span>
              <span className="fd-field-type">{f.field?.type === "YesNo" ? "Yes/No" : f.field?.type === "LongText" ? "Long Text" : f.field?.type === "ShortText" ? "Text" : f.field?.type === "DateTime" ? "Date" : (f.field?.type ?? "")}</span>
            </button>
          </li>
        ))}
        {!fields.length && <li className="muted small">{data ? "The record source has no fields." : "Loading fields…"}</li>}
      </ul>
    </aside>
  );

  return (
    <div className={`fd rdz ${compact ? "compact" : ""}`}>
      {compact && (
        <div className="fd-phone-bar">
          <button className={showFields ? "on" : ""} onClick={() => { setShowFields(!showFields); setShowProps(false); }}>
            <FieldListIcon /> Add
          </button>
          <button className={showProps ? "on" : ""} onClick={() => { setShowProps(!showProps); setShowFields(false); }}>
            <PropertySheetIcon /> Properties
          </button>
          {tool && <span className="fd-phone-hint">Tap the report to place the {CONTROL_LABELS[tool].toLowerCase()}</span>}
        </div>
      )}
      <div className="fd-body">
        {showFields && fieldPane}
        <div
          className={`fd-canvas ${tool ? "placing" : ""}`}
          ref={canvasRef}
          tabIndex={0}
          aria-label="Report design surface"
          onKeyDown={onKeyDown}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(DT_FIELD) || e.dataTransfer.types.includes(DT_CONTROL)) e.preventDefault();
          }}
          onDrop={dropAt}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget && !tool) {
              setSel([]);
              setSection(null);
            }
          }}
        >
          <div className="fd-form rdz-report" ref={formRef} style={{ width, fontFamily: 'Calibri, "Segoe UI", system-ui, sans-serif' } as CSSProperties}>
            {/* Where the paper's printable width ends. */}
            <div className={`rdz-paper-edge ${width > printableW ? "over" : ""}`} style={{ left: printableW }} title={`Printable width: ${ps.printableW.toFixed(2)}″ (${ps.w}″ paper less margins)`} />
            {sections.map((s) => {
              const h = hOf(s.key, s.height);
              const props = layout.sectionProps?.[s.key];
              return (
                <div key={s.key} className={`fd-section-wrap ${section === s.key ? "sec-selected" : ""}`}>
                  <div
                    className="fd-section-bar rdz-bar"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSel([]);
                      setSection(s.key);
                      canvasRef.current?.focus({ preventScroll: true });
                    }}
                    title="Click for this section's properties"
                  >
                    <span>{s.label}</span>
                    {props?.hidden && <span className="fd-section-empty">hidden</span>}
                    {props?.forceNewPage && <span className="fd-section-empty">new page {props.forceNewPage}</span>}
                    {h === 0 && <span className="fd-section-empty">empty — drag the bar below to make room</span>}
                  </div>
                  <div
                    ref={(el) => {
                      sectionRefs.current[s.key] = el;
                    }}
                    className="fd-section rdz-section"
                    style={{ height: h, background: props?.backColor }}
                    onPointerDown={(e) => e.target === e.currentTarget && onSectionDown(e, s.key)}
                  >
                    {layout.controls
                      .filter((c) => c.section === s.key)
                      .map((c) => {
                        const r = rectOf(c);
                        const isSel = sel.includes(c.id);
                        const moving = preview?.kind === "move" && preview.ids.includes(c.id);
                        const style: CSSProperties = { left: r.x, top: r.y, width: r.w, height: r.h };
                        if (moving) style.transform = `translate(${preview.dx}px, ${preview.dy}px)`;
                        return (
                          <div
                            key={c.id}
                            className={`fd-ctl rdz-ctl t-${c.type} ${isSel ? "selected" : ""} ${moving ? "moving" : ""} ${c.hidden ? "is-hidden" : ""}`}
                            style={style}
                            onPointerDown={(e) => {
                              press.bind((x, y) => openControlMenu(c, x, y)).onPointerDown(e);
                              onControlDown(e, c);
                            }}
                            onPointerMove={press.bind(() => undefined).onPointerMove}
                            onPointerUp={press.bind(() => undefined).onPointerUp}
                            onPointerCancel={press.bind(() => undefined).onPointerCancel}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              if (!press.wasLongPress()) openControlMenu(c, e.clientX, e.clientY);
                            }}
                            onDoubleClick={() => !readOnly && c.type === "label" && setEditing(c.id)}
                            data-name={c.name}
                          >
                            <div className="fd-ctl-body">
                              <ReportControlView c={c} baseFont={baseFont} design />
                            </div>
                            {editing === c.id && (
                              <textarea
                                className="fd-inline-edit"
                                autoFocus
                                defaultValue={c.caption ?? ""}
                                aria-label="Caption"
                                onFocus={(e) => e.currentTarget.select()}
                                onPointerDown={(e) => e.stopPropagation()}
                                onBlur={(e) => commitCaption(c, e.currentTarget.value)}
                                onKeyDown={(e) => {
                                  e.stopPropagation();
                                  if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    commitCaption(c, e.currentTarget.value);
                                    canvasRef.current?.focus({ preventScroll: true });
                                  } else if (e.key === "Escape") {
                                    setEditing(null);
                                    canvasRef.current?.focus({ preventScroll: true });
                                  }
                                }}
                              />
                            )}
                            {isSel && selected.length === 1 && !readOnly && editing !== c.id && HANDLES.map((hd) => <span key={hd} className={`fd-handle h-${hd}`} onPointerDown={(e) => onHandleDown(e, c, hd)} />)}
                          </div>
                        );
                      })}
                    {preview?.kind === "place" && preview.section === s.key && (
                      <div className="fd-place" style={{ left: preview.rect.x, top: preview.rect.y, width: preview.rect.w, height: preview.rect.h }} />
                    )}
                  </div>
                  <div className="fd-section-grip" onPointerDown={(e) => onSectionResize(e, s.key, s.max)} title={`Drag to resize the ${s.label}`} />
                </div>
              );
            })}
            <div className="fd-width-grip" onPointerDown={onWidthResize} title="Drag to change the report's width" />
            {preview?.kind === "marquee" && <div className="fd-marquee" style={{ left: preview.rect.x, top: preview.rect.y, width: preview.rect.w, height: preview.rect.h }} />}
          </div>
          <div className="fd-status" aria-live="polite">
            {preview?.kind === "move" && primary
              ? `Moving ${preview.ids.length > 1 ? `${preview.ids.length} controls` : primary.name} · ${primary.x + preview.dx}, ${primary.y + preview.dy}`
              : preview?.kind === "resize"
                ? `${preview.rect.w} × ${preview.rect.h}`
                : preview?.kind === "section"
                  ? `${sections.find((s) => s.key === preview.section)?.label} height ${preview.h} (${(preview.h / DPI).toFixed(2)}″)`
                  : preview?.kind === "width"
                    ? `Report width ${(preview.w / DPI).toFixed(2)}″ · printable ${ps.printableW.toFixed(2)}″`
                    : tool
                      ? `Click or drag on the report to add a ${CONTROL_LABELS[tool].toLowerCase()} · Esc to cancel`
                      : primary
                        ? `${primary.name} · ${primary.x}, ${primary.y} · ${primary.w} × ${primary.h}`
                        : width > printableW
                          ? `The report is ${((width - printableW) / DPI).toFixed(2)}″ wider than the paper's printable width: drag its right edge left, or change the page setup.`
                          : `${layout.controls.length} control${layout.controls.length === 1 ? "" : "s"} · ${ps.w}″ × ${ps.h}″ page`}
          </div>
        </div>
        {showProps && (
          <aside className="fd-pane fd-right">
            {selected.length ? (
              <FormPropertySheet
                report
                form={{ id: report.id, name: report.name, title: report.title, source: report.source, columns: report.columns } as FormDef}
                layout={{ controls: layout.controls } as never}
                selected={selected as unknown as FormControl[]}
                fields={fields}
                sample={data}
                onPatch={(p) => patchSelected(p as Partial<ReportControl>)}
                onForm={() => {}}
                onClose={compact ? () => setShowProps(false) : undefined}
              />
            ) : (
              <ReportPropertySheet
                report={report}
                layout={layout}
                section={section}
                fields={fields.map((f) => f.name)}
                mutate={mutate}
                onClose={compact ? () => setShowProps(false) : undefined}
              />
            )}
          </aside>
        )}
        {styleControl && (
          <FontStyleDialog control={styleControl} baseSize={baseFont} onPatch={(patch) => patchSelected(patch, [styleControl.id])} onClose={() => setStyling(null)} />
        )}
        {ctlMenu && menuControl && (
          <ControlMenu
            x={ctlMenu.x}
            y={ctlMenu.y}
            title={textOf(menuControl)?.value ? `${textOf(menuControl)!.value} (${menuControl.name})` : menuControl.name}
            onClose={() => setCtlMenu(null)}
            items={[
              ...(textOf(menuControl) ? [{ label: "Edit Text", run: () => void editText(menuControl) }] : []),
              { label: "Font & Style…", run: () => setStyling(menuControl.id) },
              { label: "Delete", danger: true, run: () => (mutate((l) => (l.controls = l.controls.filter((x) => x.id !== menuControl.id))), setSel([])) },
            ]}
          />
        )}
      </div>
    </div>
  );
}
