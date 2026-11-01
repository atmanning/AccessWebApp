/**
 * Form Design View: a canvas with the form's header, detail and footer sections. Drag controls from the
 * toolbox or fields from the field list, then move, resize and align them; the Property Sheet edits
 * whatever is selected. Every finished gesture is one undo step.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { FORM_CONTROL_TYPES, FORM_SECTIONS, type FormControl, type FormControlType, type FormDef, type FormLayout, type FormSection } from "../../../shared/model";
import { useLayout } from "../ui/layout";
import { useSource } from "../views/FormReportViews";
import { useCommands, useWorkspace } from "../workspace/context";
import { newId } from "../workspace/docOps";
import { FormControlView } from "./FormControls";
import { CONTROL_ICONS, FieldListIcon, PropertySheetIcon } from "./formIcons";
import {
  CONTROL_LABELS,
  controlTypeForField,
  GRID,
  layoutFields,
  layoutOf,
  makeControl,
  nextControlName,
  SECTION_LABELS,
  sectionContentBottom,
  snap,
  syncColumns,
  themeStyle,
  THEMES,
} from "./formLayout";
import { FormPropertySheet } from "./FormPropertySheet";

type Rect = { x: number; y: number; w: number; h: number };
type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

type Preview =
  | { kind: "move"; ids: string[]; dx: number; dy: number }
  | { kind: "resize"; id: string; rect: Rect }
  | { kind: "marquee"; rect: Rect }
  | { kind: "place"; section: FormSection; rect: Rect }
  | { kind: "section"; section: FormSection; h: number }
  | { kind: "width"; w: number };

/** Copied controls, shared by every form in this browser tab. */
let controlClipboard: FormControl[] | null = null;

const DT_FIELD = "application/x-accessweb-field";
const DT_CONTROL = "application/x-accessweb-control";

/** Follows the pointer until it's released; gives the distance moved in page pixels. */
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

export function FormDesigner({ form, tabKey }: { form: FormDef; tabKey: string }) {
  const ws = useWorkspace();
  const { compact, touch } = useLayout();
  const { data } = useSource(form.source);
  const fields = useMemo(() => (data ? data.columns.map((name, i) => ({ name, field: data.fields[i] })) : []), [data]);
  const layout = useMemo(() => layoutOf(form, fields), [form, fields]);
  const [sel, setSel] = useState<string[]>([]);
  const [tool, setTool] = useState<FormControlType | null>(null);
  const [showFields, setShowFields] = useState(!compact);
  const [showProps, setShowProps] = useState(!compact);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Partial<Record<FormSection, HTMLDivElement | null>>>({});
  const readOnly = ws.readOnly;

  // Forget selected controls that no longer exist (undo, delete).
  useEffect(() => {
    setSel((s) => (s.every((id) => layout.controls.some((c) => c.id === id)) ? s : s.filter((id) => layout.controls.some((c) => c.id === id))));
  }, [layout]);

  const byId = (id: string) => layout.controls.find((c) => c.id === id);
  const selected = sel.map(byId).filter((c): c is FormControl => !!c);

  /** Changes the layout (saving a generated one the first time). One call = one undo step. */
  const mutate = (fn: (l: FormLayout, f: FormDef) => void) => {
    if (readOnly) return ws.setStatus("This database is read-only.", "error");
    ws.update((d) => {
      const f = d.forms.find((x) => x.id === form.id);
      if (!f) return;
      if (!f.layout) f.layout = structuredClone(layout);
      fn(f.layout, f);
      syncColumns(f);
    });
  };
  const patchSelected = (patch: Partial<FormControl>, ids = sel) =>
    mutate((l) => {
      for (const c of l.controls) {
        if (!ids.includes(c.id)) continue;
        Object.assign(c, patch);
        for (const k of Object.keys(patch) as (keyof FormControl)[]) if (patch[k] === undefined) delete c[k];
      }
      fitSections(l);
    });

  /** Grows sections and the form so every control fits (Access does the same). */
  const fitSections = (l: FormLayout) => {
    for (const s of FORM_SECTIONS) {
      const bottom = sectionContentBottom(l, s);
      if (bottom > l.sections[s]) l.sections[s] = Math.min(s === "detail" ? 4000 : 2000, snap(bottom + GRID / 2));
    }
    const right = l.controls.reduce((m, c) => Math.max(m, c.x + c.w), 0);
    if (right > l.width) l.width = Math.min(4000, snap(right + GRID / 2));
  };

  // ---- Geometry ------------------------------------------------------------------------------
  /** Each section's top edge in form coordinates (measured, so the section bars are accounted for). */
  const sectionTops = () => {
    const base = formRef.current!.getBoundingClientRect();
    const out = {} as Record<FormSection, number>;
    for (const s of FORM_SECTIONS) out[s] = (sectionRefs.current[s]?.getBoundingClientRect().top ?? base.top) - base.top;
    return out;
  };
  const toForm = (clientX: number, clientY: number) => {
    const r = formRef.current!.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };
  /** Section under a form-coordinate y, or the nearest one. */
  const sectionAt = (y: number, tops: Record<FormSection, number>): FormSection => {
    let best: FormSection = "detail";
    let bestDist = Infinity;
    for (const s of FORM_SECTIONS) {
      const h = layout.sections[s];
      if (h <= 0) continue;
      const top = tops[s];
      if (y >= top && y < top + h) return s;
      const d = Math.min(Math.abs(y - top), Math.abs(y - (top + h)));
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  };

  // ---- Adding controls -----------------------------------------------------------------------
  const addControls = (make: (l: FormLayout) => FormControl[], opts: { edit?: boolean } = {}) => {
    let ids: string[] = [];
    mutate((l) => {
      const made = make(l);
      l.controls.push(...made);
      ids = made.map((c) => c.id);
      fitSections(l);
    });
    setSel(ids);
    setTool(null);
    if (opts.edit && ids.length === 1) setEditing(ids[0]);
    canvasRef.current?.focus({ preventScroll: true });
  };
  const fieldControl = (l: FormLayout, name: string, at: { section: FormSection; x: number; y: number }) => {
    const fd = fields.find((f) => f.name === name)?.field;
    const kind = controlTypeForField(fd);
    return makeControl(l, kind.type, at, { field: name, fieldDef: fd, multiline: kind.multiline });
  };
  /** Next free spot at the bottom of the detail section, for click-to-add. */
  const nextSpot = (l: FormLayout) => ({ section: "detail" as FormSection, x: 24, y: snap(sectionContentBottom(l, "detail") + 16) });
  const addField = (name: string, at?: { section: FormSection; x: number; y: number }) => addControls((l) => [fieldControl(l, name, at ?? nextSpot(l))]);
  const addTool = (type: FormControlType, at?: { section: FormSection; x: number; y: number; w?: number; h?: number }) =>
    addControls((l) => [makeControl(l, type, at ?? nextSpot(l))], { edit: type === "label" });

  const dropAt = (e: DragEvent) => {
    const f = e.dataTransfer.getData(DT_FIELD);
    const t = e.dataTransfer.getData(DT_CONTROL) as FormControlType;
    if (!f && !t) return;
    e.preventDefault();
    const p = toForm(e.clientX, e.clientY);
    const tops = sectionTops();
    const section = sectionAt(p.y, tops);
    const at = { section, x: snap(Math.max(0, p.x - 12)), y: snap(Math.max(0, p.y - tops[section] - 8)) };
    if (f) addField(f, at);
    else if (FORM_CONTROL_TYPES.includes(t)) addTool(t, at);
  };

  // ---- Pointer gestures ----------------------------------------------------------------------
  const onControlDown = (e: RPointerEvent, c: FormControl) => {
    if (e.button !== 0 || editing === c.id) return;
    e.stopPropagation();
    canvasRef.current?.focus({ preventScroll: true });
    if (tool) return onSectionDown(e, c.section);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (additive) {
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
        const on = !ev.altKey;
        setPreview({ kind: "move", ids, dx: snap(dx, on), dy: snap(dy, on) });
      },
      (dx, dy, ev) => {
        setPreview(null);
        if (!moved) {
          if (wasSelected && sel.length > 1) setSel([c.id]);
          return;
        }
        const on = !ev.altKey;
        const ddx = snap(dx, on);
        const ddy = snap(dy, on);
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

  const onHandleDown = (e: RPointerEvent, c: FormControl, h: Handle) => {
    e.stopPropagation();
    e.preventDefault();
    if (readOnly) return;
    const minW = c.type === "line" ? 1 : 8;
    const minH = c.type === "line" ? 1 : 8;
    const calc = (dx: number, dy: number, on: boolean): Rect => {
      let { x, y, w, h: hh } = c;
      if (h.includes("e")) w = Math.max(minW, snap(c.x + c.w + dx, on) - c.x);
      if (h.includes("s")) hh = Math.max(minH, snap(c.y + c.h + dy, on) - c.y);
      if (h.includes("w")) {
        const nx = Math.min(c.x + c.w - minW, Math.max(0, snap(c.x + dx, on)));
        w = c.x + c.w - nx;
        x = nx;
      }
      if (h.includes("n")) {
        const ny = Math.min(c.y + c.h - minH, Math.max(0, snap(c.y + dy, on)));
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
        if (r.x === c.x && r.y === c.y && r.w === c.w && r.h === c.h) return;
        patchSelected({ x: r.x, y: r.y, w: Math.min(4000, r.w), h: Math.min(4000, r.h) }, [c.id]);
      },
    );
  };

  const onSectionDown = (e: RPointerEvent, section: FormSection) => {
    if (e.button !== 0) return;
    canvasRef.current?.focus({ preventScroll: true });
    setEditing(null);
    const start = toForm(e.clientX, e.clientY);
    const tops = sectionTops();
    if (tool) {
      e.preventDefault();
      const type = tool;
      const sy = start.y - tops[section];
      const local = (dx: number, dy: number, on: boolean) => {
        const r = normRect(start.x, sy, start.x + dx, sy + dy);
        return { x: snap(Math.max(0, r.x), on), y: snap(Math.max(0, r.y), on), w: snap(r.w, on), h: snap(r.h, on) };
      };
      track(
        e,
        (dx, dy, ev) => setPreview({ kind: "place", section, rect: local(dx, dy, !ev.altKey) }),
        (dx, dy, ev) => {
          setPreview(null);
          const r = local(dx, dy, !ev.altKey);
          const big = r.w >= GRID * 2 && r.h >= (type === "line" ? 1 : GRID * 2);
          addTool(type, big ? { section, ...r, h: type === "line" && r.h < GRID * 2 ? 2 : r.h } : { section, x: r.x, y: r.y });
        },
      );
      return;
    }
    // Touch: dragging the background scrolls the page; a tap clears the selection.
    if (e.pointerType === "touch") {
      setSel([]);
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
        if (r.w < 3 && r.h < 3) return setSel(keep);
        const hit = layout.controls.filter((c) => intersects(r, { x: c.x, y: tops[c.section] + c.y, w: c.w, h: c.h })).map((c) => c.id);
        setSel([...new Set([...keep, ...hit])]);
      },
    );
  };

  const onSectionResize = (e: RPointerEvent, section: FormSection) => {
    e.stopPropagation();
    e.preventDefault();
    if (readOnly) return;
    const h0 = layout.sections[section];
    const min = Math.max(section === "detail" ? 16 : 0, sectionContentBottom(layout, section));
    const max = section === "detail" ? 4000 : 2000;
    const calc = (dy: number, on: boolean) => Math.min(max, Math.max(min, snap(h0 + dy, on)));
    track(
      e,
      (_, dy, ev) => setPreview({ kind: "section", section, h: calc(dy, !ev.altKey) }),
      (_, dy, ev) => {
        setPreview(null);
        const h = calc(dy, !ev.altKey);
        if (h !== h0) mutate((l) => (l.sections[section] = h));
      },
    );
  };

  const onWidthResize = (e: RPointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (readOnly) return;
    const w0 = layout.width;
    const min = Math.max(160, layout.controls.reduce((m, c) => Math.max(m, c.x + c.w), 0));
    const calc = (dx: number, on: boolean) => Math.min(4000, Math.max(min, snap(w0 + dx, on)));
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
  const paste = (items: FormControl[], offset: number) => {
    addControls((l) => {
      const out: FormControl[] = [];
      for (const it of items) {
        const c = structuredClone(it);
        c.id = newId("c");
        c.x = Math.min(4000 - c.w, c.x + offset);
        c.y = Math.min(4000 - c.h, c.y + offset);
        const taken = new Set([...l.controls, ...out].map((x) => x.name.toLowerCase()));
        if (taken.has(c.name.toLowerCase())) c.name = nextControlName({ ...l, controls: [...l.controls, ...out] }, c.name.replace(/\d+$/, "") || "Control");
        out.push(c);
      }
      return out;
    });
  };
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
    // Like Access's "To Widest" / "To Tallest".
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
  const relayout = (style: "stacked" | "columns") => {
    const bound = layout.controls.filter((c) => c.section === "detail" && c.field);
    const names = bound.length ? bound.map((c) => c.field!) : fields.map((f) => f.name);
    mutate((l) => {
      layoutFields(
        l,
        names.map((n) => ({ name: n, field: fields.find((f) => f.name.toLowerCase() === n.toLowerCase())?.field })),
        style,
      );
      // Header and footer controls keep their places; stretch a full-width title with the form.
      fitSections(l);
    });
    setSel([]);
    ws.setStatus(style === "columns" ? "Fields arranged in two columns." : "Fields arranged in one column.");
  };

  useCommands(tabKey, {
    formDesign: {
      tool,
      setTool: (t) => setTool((cur) => (cur === t ? null : t)),
      selectionCount: sel.length,
      align,
      sameSize,
      order,
      theme: layout.theme,
      setTheme: (t) => mutate((l) => (l.theme = t)),
      fieldList: showFields,
      toggleFieldList: () => setShowFields((v) => !v),
      propertySheet: showProps,
      togglePropertySheet: () => setShowProps((v) => !v),
      relayout,
      remove: removeSelected,
    },
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement) !== canvasRef.current) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (k === "Escape") {
      if (tool) setTool(null);
      else setSel([]);
      return;
    }
    if (mod && k.toLowerCase() === "a") {
      e.preventDefault();
      setSel(layout.controls.map((c) => c.id));
      return;
    }
    if (!sel.length) {
      if (mod && k.toLowerCase() === "v" && controlClipboard) {
        e.preventDefault();
        paste(controlClipboard, GRID * 2);
      }
      return;
    }
    if (k === "Delete" || k === "Backspace") {
      e.preventDefault();
      removeSelected();
    } else if (mod && k.toLowerCase() === "c") {
      e.preventDefault();
      controlClipboard = structuredClone(selected);
      ws.setStatus(`${selected.length} control${selected.length > 1 ? "s" : ""} copied.`);
    } else if (mod && k.toLowerCase() === "x") {
      e.preventDefault();
      controlClipboard = structuredClone(selected);
      removeSelected();
    } else if (mod && k.toLowerCase() === "v" && controlClipboard) {
      e.preventDefault();
      paste(controlClipboard, GRID * 2);
    } else if (mod && k.toLowerCase() === "d") {
      e.preventDefault();
      paste(selected, GRID * 2);
    } else if (k === "Enter" && selected.length === 1 && ["label", "button", "checkbox"].includes(selected[0].type)) {
      e.preventDefault();
      setEditing(selected[0].id);
    } else if (k.startsWith("Arrow")) {
      e.preventDefault();
      // Arrows move by the grid, Ctrl+arrows by one pixel, Shift+arrows resize.
      const step = mod ? 1 : GRID;
      const dx = k === "ArrowLeft" ? -step : k === "ArrowRight" ? step : 0;
      const dy = k === "ArrowUp" ? -step : k === "ArrowDown" ? step : 0;
      mutate((l) => {
        for (const c of l.controls) {
          if (!sel.includes(c.id)) continue;
          if (e.shiftKey) {
            c.w = Math.max(c.type === "line" ? 1 : 8, Math.min(4000, c.w + dx));
            c.h = Math.max(c.type === "line" ? 1 : 8, Math.min(4000, c.h + dy));
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
  const sectionH = (s: FormSection) => (preview?.kind === "section" && preview.section === s ? preview.h : layout.sections[s]);
  const rectOf = (c: FormControl): Rect => {
    if (preview?.kind === "resize" && preview.id === c.id) return preview.rect;
    return { x: c.x, y: c.y, w: c.w, h: c.h };
  };
  const primary = selected.length ? selected[selected.length - 1] : null;
  const onForm = new Set(layout.controls.map((c) => c.field?.toLowerCase()).filter(Boolean));

  const commitCaption = (c: FormControl, text: string) => {
    setEditing(null);
    if (text !== (c.caption ?? "")) patchSelected({ caption: text.slice(0, 500) }, [c.id]);
  };

  const toolbox = (
    <div className="fd-toolbox" role="toolbar" aria-label="Controls">
      {FORM_CONTROL_TYPES.map((t) => {
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
            title={`${CONTROL_LABELS[t]}: click, then click or drag on the form${touch ? "" : " (or drag it onto the form)"}`}
          >
            <Icon size={20} />
            <span>{CONTROL_LABELS[t]}</span>
          </button>
        );
      })}
    </div>
  );

  const fieldPane = (
    <aside className="fd-pane fd-left">
      <div className="fd-pane-title">Controls</div>
      {toolbox}
      <div className="fd-pane-title">
        Fields
        <span className="fd-pane-sub">{form.source.kind === "table" ? "Table" : "Query"}: {ws.doc.tables.find((t) => t.id === form.source.id)?.name ?? ws.doc.queries.find((q) => q.id === form.source.id)?.name ?? "(missing)"}</span>
      </div>
      <ul className="fd-fields">
        {fields.map((f) => (
          <li key={f.name}>
            <button
              className={`fd-field ${onForm.has(f.name.toLowerCase()) ? "used" : ""}`}
              draggable={!touch && !readOnly}
              disabled={readOnly}
              onDragStart={(e) => e.dataTransfer.setData(DT_FIELD, f.name)}
              onClick={() => addField(f.name)}
              title={`Add ${f.name} to the form${touch ? "" : " (or drag it to a spot)"}`}
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

  const controlsIn = (s: FormSection) => layout.controls.filter((c) => c.section === s);

  return (
    <div className={`fd ${compact ? "compact" : ""}`}>
      {compact && (
        <div className="fd-phone-bar">
          <button className={showFields ? "on" : ""} onClick={() => { setShowFields(!showFields); setShowProps(false); }}>
            <FieldListIcon /> Add
          </button>
          <button className={showProps ? "on" : ""} onClick={() => { setShowProps(!showProps); setShowFields(false); }}>
            <PropertySheetIcon /> Properties
          </button>
          {tool && <span className="fd-phone-hint">Tap the form to place the {CONTROL_LABELS[tool].toLowerCase()}</span>}
        </div>
      )}
      <div className="fd-body">
        {showFields && fieldPane}
        <div
          className={`fd-canvas ${tool ? "placing" : ""}`}
          ref={canvasRef}
          tabIndex={0}
          aria-label="Form design surface"
          onKeyDown={onKeyDown}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(DT_FIELD) || e.dataTransfer.types.includes(DT_CONTROL)) e.preventDefault();
          }}
          onDrop={dropAt}
          onPointerDown={(e) => {
            // Clicking the grey area around the form selects the form itself.
            if (e.target === e.currentTarget && !tool) setSel([]);
          }}
        >
          <div className={`fd-form theme-${layout.theme}`} ref={formRef} style={{ ...(themeStyle(layout.theme) as CSSProperties), width }}>
            {FORM_SECTIONS.map((s) => (
              <div key={s} className="fd-section-wrap">
                <div className="fd-section-bar">
                  <span>{SECTION_LABELS[s]}</span>
                  {sectionH(s) === 0 && <span className="fd-section-empty">empty — drag the bar below to make room</span>}
                </div>
                <div
                  ref={(el) => {
                    sectionRefs.current[s] = el;
                  }}
                  className={`fd-section fv-section fv-${s}`}
                  style={{ height: sectionH(s) }}
                  onPointerDown={(e) => e.target === e.currentTarget && onSectionDown(e, s)}
                >
                  {controlsIn(s).map((c) => {
                    const r = rectOf(c);
                    const isSel = sel.includes(c.id);
                    const moving = preview?.kind === "move" && preview.ids.includes(c.id);
                    const style: CSSProperties = { left: r.x, top: r.y, width: r.w, height: r.h };
                    if (moving) style.transform = `translate(${preview.dx}px, ${preview.dy}px)`;
                    return (
                      <div
                        key={c.id}
                        className={`fd-ctl fv-ctl t-${c.type} ${isSel ? "selected" : ""} ${moving ? "moving" : ""} ${c.hidden ? "is-hidden" : ""}`}
                        style={style}
                        onPointerDown={(e) => onControlDown(e, c)}
                        onDoubleClick={() => !readOnly && ["label", "button", "checkbox"].includes(c.type) && setEditing(c.id)}
                        data-name={c.name}
                      >
                        <div className="fd-ctl-body">
                          <FormControlView c={c} />
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
                        {isSel && selected.length === 1 && !readOnly && editing !== c.id &&
                          HANDLES.map((h) => <span key={h} className={`fd-handle h-${h}`} onPointerDown={(e) => onHandleDown(e, c, h)} />)}
                      </div>
                    );
                  })}
                  {preview?.kind === "place" && preview.section === s && (
                    <div className="fd-place" style={{ left: preview.rect.x, top: preview.rect.y, width: preview.rect.w, height: preview.rect.h }} />
                  )}
                </div>
                <div className="fd-section-grip" onPointerDown={(e) => onSectionResize(e, s)} title={`Drag to resize the ${SECTION_LABELS[s]}`} />
              </div>
            ))}
            <div className="fd-width-grip" onPointerDown={onWidthResize} title="Drag to change the form's width" />
            {preview?.kind === "marquee" && (
              <div className="fd-marquee" style={{ left: preview.rect.x, top: preview.rect.y, width: preview.rect.w, height: preview.rect.h }} />
            )}
          </div>
          <div className="fd-status" aria-live="polite">
            {preview?.kind === "move" && primary
              ? `Moving ${preview.ids.length > 1 ? `${preview.ids.length} controls` : primary.name} · ${primary.x + preview.dx}, ${primary.y + preview.dy}`
              : preview?.kind === "resize"
                ? `${preview.rect.w} × ${preview.rect.h}`
                : preview?.kind === "section"
                  ? `${SECTION_LABELS[preview.section]} height ${preview.h}`
                  : preview?.kind === "width"
                    ? `Form width ${preview.w}`
                    : tool
                      ? `Click or drag on the form to add a ${CONTROL_LABELS[tool].toLowerCase()} · Esc to cancel`
                      : primary
                        ? `${primary.name} · ${primary.x}, ${primary.y} · ${primary.w} × ${primary.h}`
                        : `${THEMES[layout.theme].label} theme · ${layout.controls.length} control${layout.controls.length === 1 ? "" : "s"}`}
          </div>
        </div>
        {showProps && (
          <aside className="fd-pane fd-right">
            <FormPropertySheet
              form={form}
              layout={layout}
              selected={selected}
              fields={fields}
              onPatch={(p) => patchSelected(p)}
              onForm={(fn) => mutate((l, f) => fn(f, l))}
              onClose={compact ? () => setShowProps(false) : undefined}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
