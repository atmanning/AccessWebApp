import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CellValue, Field } from "../../../shared/model";
import { editText, formatValue, isNumericType } from "../engine/values";
import { acceptsDateText, dateShortcut, insertAtCaret, nowText, type DateShortcut } from "../ui/dateKeys";
import { FindIcon } from "../ui/icons";
import { useLayout } from "../ui/layout";
import type { ColumnLookup } from "./lookups";

export interface DatasheetColumn {
  key: string;
  label: string;
  field?: Field;
  readOnly?: boolean;
  /** Shown in the status bar when someone tries to type in a read-only column. */
  readOnlyReason?: string;
  /** A lookup field: shows the display value and edits with a drop-down list. */
  lookup?: ColumnLookup;
}

export interface DatasheetProps {
  columns: DatasheetColumn[];
  rowCount: number;
  getValue: (row: number, col: number) => CellValue;
  rowKey: (row: number) => string;
  editable: boolean;
  /** Show the new-record row (defaults to `editable`; query results edit existing records only). */
  allowNew?: boolean;
  /** Returns an error message to keep the editor open, or null on success. `row` is "new" for the new-record row. */
  onCommit?: (row: number | "new", col: number, input: string | boolean) => string | null;
  onDeleteRows?: (rows: number[]) => void;
  /** Value shown in the new-record row before anything is typed. */
  newRowPlaceholder?: (col: number) => string;
  /** Column widths saved with the table or query, by column key. */
  savedWidths?: Record<string, number>;
  /** Called after the user resizes a column (drag, or double-click to best fit). */
  onWidthsChange?: (widths: Record<string, number>) => void;
  /** Saved row height in pixels for every row (unset = standard height). */
  rowHeight?: number;
  /** Called after the user drags a row border; undefined means back to standard height. */
  onRowHeightChange?: (height: number | undefined) => void;
  /** Highlight cells that need attention (e.g. required but empty). */
  cellWarning?: (row: number, col: number) => boolean;
  emptyMessage?: string;
  onStatus?: (message: string, kind?: "info" | "error") => void;
}

export interface DatasheetHandle {
  sort: (dir: "ASC" | "DESC" | null) => void;
  goToNewRecord: () => void;
  deleteSelected: () => void;
  focusFind: () => void;
  selectedRowCount: () => number;
}

/** Row height: taller on touch screens so a finger can pick a row. */
const ROW_H_DESKTOP = 24;
const ROW_H_TOUCH = 36;
const OVERSCAN = 10;
export const MIN_ROW_H = 16;
export const MAX_ROW_H = 300;

type Cell = { r: number; c: number }; // r is a display index; r === displayCount means the new-record row

export const Datasheet = forwardRef<DatasheetHandle, DatasheetProps>(function Datasheet(p, ref) {
  const { touch } = useLayout();
  const standardH = touch ? ROW_H_TOUCH : ROW_H_DESKTOP;
  // Row height being dragged (live), else the saved one, else the standard height.
  const [dragH, setDragH] = useState<number | null>(null);
  const ROW_H = dragH ?? p.rowHeight ?? standardH;
  const customH = dragH !== null || p.rowHeight !== undefined;
  // Rows taller than about two lines wrap their text, like Access.
  const tall = ROW_H >= 34 && ROW_H > standardH;
  // Touch: tapping the cell that's already selected starts editing (instead of double-click).
  const wasActive = useRef(false);
  const [sort, setSort] = useState<{ col: number; dir: "ASC" | "DESC" } | null>(null);
  const [filter, setFilter] = useState("");
  // An empty table starts in the first field you can type in, like Access.
  const [cell, setCell] = useState<Cell>(() => ({
    r: 0,
    c: p.rowCount ? 0 : Math.max(0, p.columns.findIndex((c) => !c.readOnly && c.field?.type !== "AutoNumber")),
  }));
  const [selRows, setSelRows] = useState<Set<number>>(new Set()); // display indexes
  // `list`: a lookup's drop-down is open; `hi`: its highlighted choice; `typed`: filter the list by the text.
  const [editing, setEditing] = useState<{ text: string; list?: boolean; hi?: number; typed?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>(() => ({ ...(p.savedWidths ?? {}) }));
  const widthsRef = useRef(widths);
  widthsRef.current = widths;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  const scroller = useRef<HTMLDivElement>(null);
  const findBox = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Lookup columns show the display value for the stored one (e.g. a customer's name for their ID).
  const labelMaps = useMemo(() => p.columns.map((col) => (col.lookup ? new Map(col.lookup.options.map((o) => [o.value, o.label])) : null)), [p.columns]);
  const shown = (c: number, v: CellValue): string => {
    const col = p.columns[c];
    const m = labelMaps[c];
    if (m && v !== null && v !== undefined && v !== "") return m.get(col.field ? editText(col.field, v) : String(v)) ?? formatValue(col.field, v);
    return formatValue(col?.field, v);
  };

  // Display order: filter then sort, as indexes into the underlying rows.
  const order = useMemo(() => {
    let idx = Array.from({ length: p.rowCount }, (_, i) => i);
    const f = filter.trim().toLowerCase();
    if (f) {
      idx = idx.filter((r) =>
        p.columns.some((_, c) => shown(c, p.getValue(r, c)).toLowerCase().includes(f)),
      );
    }
    if (sort) {
      const col = p.columns[sort.col];
      const numeric = isNumericType(col?.field?.type);
      const dir = sort.dir === "ASC" ? 1 : -1;
      const byLabel = !!col?.lookup;
      idx.sort((a, b) => {
        const va = byLabel ? shown(sort.col, p.getValue(a, sort.col)) : p.getValue(a, sort.col);
        const vb = byLabel ? shown(sort.col, p.getValue(b, sort.col)) : p.getValue(b, sort.col);
        if (va === null || va === undefined || va === "") return vb === null || vb === undefined || vb === "" ? 0 : -dir;
        if (vb === null || vb === undefined || vb === "") return dir;
        if (!byLabel && (numeric || (typeof va === "number" && typeof vb === "number"))) return (Number(va) - Number(vb)) * dir;
        return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" }) * dir;
      });
    }
    return idx;
    // getValue changes identity when data changes, so it's the right dependency.
  }, [p.rowCount, p.getValue, p.columns, labelMaps, sort, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const count = order.length;
  const allowNew = p.allowNew ?? p.editable;
  const totalRows = count + (allowNew ? 1 : 0);
  const isNewRow = (r: number) => allowNew && r === count;
  const colCount = p.columns.length;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the current cell in range when data shrinks.
  useEffect(() => {
    if (cell.r >= totalRows && totalRows > 0) setCell((c) => ({ ...c, r: totalRows - 1 }));
    if (cell.c >= colCount && colCount > 0) setCell((c) => ({ ...c, c: colCount - 1 }));
  }, [totalRows, colCount, cell.r, cell.c]);

  const scrollIntoView = (r: number) => {
    const el = scroller.current;
    if (!el) return;
    const top = r * ROW_H;
    const headerH = ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight - headerH) el.scrollTop = top + ROW_H - el.clientHeight + headerH;
  };

  const moveTo = (r: number, c: number, keepSelection = false) => {
    if (editing && !commit()) return false;
    const nr = Math.max(0, Math.min(totalRows - 1, r));
    const nc = Math.max(0, Math.min(colCount - 1, c));
    setCell({ r: nr, c: nc });
    if (!keepSelection) setSelRows(new Set());
    scrollIntoView(nr);
    return true;
  };

  const firstEditableCol = () => Math.max(0, p.columns.findIndex((_, c) => canEdit(c)));

  /** Record navigator buttons: move, then give the keyboard back to the grid. */
  const navTo = (r: number) => {
    moveTo(r, r === count ? firstEditableCol() : cell.c);
    scroller.current?.focus();
  };

  useEffect(() => {
    scroller.current?.focus({ preventScroll: true });
  }, []);

  const valueAt = (r: number, c: number): CellValue => (isNewRow(r) ? null : p.getValue(order[r], c));

  const canEdit = (c: number) => p.editable && !p.columns[c]?.readOnly && p.columns[c]?.field?.type !== "AutoNumber";

  const startEdit = (initial?: string, openList = false) => {
    if (!canEdit(cell.c)) {
      const col = p.columns[cell.c];
      if (col?.readOnlyReason) p.onStatus?.(col.readOnlyReason, "error");
      else if (col?.field?.type === "AutoNumber" && p.editable) p.onStatus?.("This field is an AutoNumber; Access fills it in for you.");
      return;
    }
    const field = p.columns[cell.c].field;
    if (field?.type === "YesNo") return toggle();
    if (p.columns[cell.c].lookup) {
      // Lookups edit the display text; typing filters the list, like an Access combo box.
      const v = valueAt(cell.r, cell.c);
      const text = initial ?? (v === null || v === undefined || v === "" ? "" : shown(cell.c, v));
      setEditing({ text, list: openList || initial !== undefined, typed: initial !== undefined, hi: 0 });
      setError(null);
      return;
    }
    setEditing({ text: initial ?? (field ? editText(field, valueAt(cell.r, cell.c)) : String(valueAt(cell.r, cell.c) ?? "")) });
    setError(null);
  };

  /** A lookup's text as the value to store: a listed choice (by what's shown, or its value), else what was typed. */
  const lookupValue = (c: number, text: string): { value: string } | { error: string } => {
    const lk = p.columns[c].lookup!;
    const t = text.trim();
    if (!t) return { value: "" };
    const low = t.toLowerCase();
    const opt = lk.options.find((o) => o.label.toLowerCase() === low) ?? lk.options.find((o) => o.value.toLowerCase() === low);
    if (opt) return { value: opt.value };
    if (lk.limit && !lk.loading) return { error: "The text you entered isn't an item in the list. Select an item from the list, or enter text that matches one of the listed items." };
    return { value: t };
  };
  const lookupMatches = (c: number, text: string, typed?: boolean) => {
    const opts = p.columns[c]?.lookup?.options ?? [];
    const t = text.trim().toLowerCase();
    if (!typed || !t) return opts;
    const starts = opts.filter((o) => o.label.toLowerCase().startsWith(t));
    return starts.length ? starts : opts.filter((o) => o.label.toLowerCase().includes(t));
  };

  /** Saves the editor's text (or `override`). Returns false if the value was rejected. */
  function commit(override?: string): boolean {
    if (!editing) return true;
    const field = p.columns[cell.c]?.field;
    const original = isNewRow(cell.r) ? "" : field ? editText(field, valueAt(cell.r, cell.c)) : "";
    let text = override ?? editing.text;
    if (p.columns[cell.c]?.lookup) {
      const r = lookupValue(cell.c, text);
      if ("error" in r) {
        setError(r.error);
        p.onStatus?.(r.error, "error");
        editorRef.current?.focus();
        return false;
      }
      text = r.value;
    }
    if (text === original) {
      setEditing(null);
      return true;
    }
    if (isNewRow(cell.r) && text === "") {
      setEditing(null);
      return true;
    }
    const err = p.onCommit?.(isNewRow(cell.r) ? "new" : order[cell.r], cell.c, text) ?? null;
    if (err) {
      setError(err);
      p.onStatus?.(err, "error");
      editorRef.current?.focus();
      return false;
    }
    setEditing(null);
    setError(null);
    return true;
  }

  function toggle() {
    if (!canEdit(cell.c)) return;
    const v = valueAt(cell.r, cell.c);
    p.onCommit?.(isNewRow(cell.r) ? "new" : order[cell.r], cell.c, !(v === true || v === 1));
  }

  const deleteSelected = () => {
    if (!p.onDeleteRows) return;
    const rows = selRows.size ? [...selRows] : isNewRow(cell.r) ? [] : [cell.r];
    const real = rows.filter((r) => r < count).map((r) => order[r]);
    if (!real.length) {
      p.onStatus?.("Select a record to delete by clicking its row selector on the left.");
      return;
    }
    p.onDeleteRows(real);
    setSelRows(new Set());
  };

  useImperativeHandle(ref, () => ({
    sort: (dir) => {
      setSort(dir ? { col: cell.c, dir } : null);
      if (dir && p.columns[cell.c]) p.onStatus?.(`Sorted by ${p.columns[cell.c].label} (${dir === "ASC" ? "A→Z" : "Z→A"}).`);
    },
    goToNewRecord: () => {
      if (!allowNew) return;
      moveTo(count, firstEditableCol());
      scroller.current?.focus();
    },
    deleteSelected,
    focusFind: () => findBox.current?.focus(),
    selectedRowCount: () => selRows.size,
  }));

  /** Ctrl+; (date) and Ctrl+Shift+; (time), where the field can hold them. */
  const handleDateShortcut = (kind: DateShortcut): boolean => {
    const field = p.columns[cell.c]?.field;
    if (!canEdit(cell.c) || !acceptsDateText(field?.type)) {
      if (canEdit(cell.c)) p.onStatus?.(`${field?.name ?? "This field"} can't hold a ${kind}.`, "error");
      else startEdit(); // explains why the cell is read-only
      return true;
    }
    const text = nowText(kind);
    if (editing && editorRef.current) {
      insertAtCaret(editorRef.current, text);
      return true;
    }
    // Not editing: a date replaces the value; a time is added to a Date/Time field's date (or today's).
    let next = text;
    if (kind === "time" && field?.type === "DateTime") {
      const current = valueAt(cell.r, cell.c);
      next = `${current ? formatValue(field, current).split(" ")[0] : nowText("date")} ${text}`;
    }
    startEdit(next);
    return true;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const shortcut = dateShortcut(e);
    if (shortcut) {
      e.preventDefault();
      e.stopPropagation();
      handleDateShortcut(shortcut);
      return;
    }
    if (editing) {
      if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        const wasNew = isNewRow(cell.r);
        if (!commit()) return;
        // Like Access, Enter and Tab both move to the next field, wrapping to the next record.
        if (cell.c < colCount - 1) setCell({ r: wasNew ? count : cell.r, c: cell.c + 1 });
        else setCell({ r: wasNew ? count + 1 : Math.min(cell.r + 1, totalRows - 1), c: firstEditableCol() });
        scroller.current?.focus();
      } else if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        if (commit()) moveTo(cell.r, cell.c - 1);
        scroller.current?.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setEditing(null);
        setError(null);
        scroller.current?.focus();
      }
      return;
    }
    const k = e.key;
    if (p.columns[cell.c]?.lookup && e.altKey && k === "ArrowDown") startEdit(undefined, true);
    else if (k === "ArrowDown") moveTo(cell.r + 1, cell.c);
    else if (k === "ArrowUp") moveTo(cell.r - 1, cell.c);
    else if (k === "ArrowRight" || (k === "Tab" && !e.shiftKey)) {
      if (cell.c < colCount - 1) moveTo(cell.r, cell.c + 1);
      else if (k === "Tab") moveTo(cell.r + 1, firstEditableCol());
    } else if (k === "ArrowLeft" || (k === "Tab" && e.shiftKey)) moveTo(cell.r, cell.c - 1);
    else if (k === "Home") moveTo(e.ctrlKey ? 0 : cell.r, 0);
    else if (k === "End") moveTo(e.ctrlKey ? totalRows - 1 : cell.r, colCount - 1);
    else if (k === "PageDown") moveTo(cell.r + Math.floor(viewH / ROW_H) - 1, cell.c);
    else if (k === "PageUp") moveTo(cell.r - Math.floor(viewH / ROW_H) + 1, cell.c);
    else if (k === "Enter" || k === "F2") startEdit();
    else if (p.columns[cell.c]?.lookup && (k === "F4" || (e.altKey && k === "ArrowDown"))) startEdit(undefined, true);
    else if (k === " " && p.columns[cell.c]?.field?.type === "YesNo") toggle();
    else if (k === "Delete") {
      if (selRows.size) deleteSelected();
      else if (canEdit(cell.c) && !isNewRow(cell.r) && p.columns[cell.c]?.field?.type !== "YesNo") {
        const err = p.onCommit?.(order[cell.r], cell.c, "");
        if (err) p.onStatus?.(err, "error");
      }
    } else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (canEdit(cell.c) && p.columns[cell.c]?.field?.type !== "YesNo") {
        e.preventDefault();
        startEdit(k);
      } else if (!canEdit(cell.c)) startEdit(); // reports why the cell can't be edited
    } else return;
    e.preventDefault();
  };

  useEffect(() => {
    if (editing) editorRef.current?.focus();
  }, [editing !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Column resizing: drag a header edge; double-click it to fit the contents (like Access).
  const startResize = (e: React.PointerEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const th = (e.target as HTMLElement).parentElement!;
    const startW = th.getBoundingClientRect().width;
    let moved = false;
    const move = (ev: PointerEvent) => {
      moved = true;
      setWidths((w) => ({ ...w, [key]: Math.round(Math.max(40, Math.min(2000, startW + ev.clientX - startX))) }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      // Read after React has applied the last move.
      if (moved) setTimeout(() => p.onWidthsChange?.(widthsRef.current), 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  /** Dragging the bottom edge of any record selector sets the height of every row. */
  const startRowResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = ROW_H;
    let h = startH;
    const move = (ev: PointerEvent) => {
      h = Math.round(Math.max(MIN_ROW_H, Math.min(MAX_ROW_H, startH + ev.clientY - startY)));
      setDragH(h);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setDragH(null);
      if (h !== startH) {
        p.onRowHeightChange?.(h === standardH ? undefined : h);
        p.onStatus?.(`Row height: ${h} pixels.`);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const bestFit = (c: number) => {
    const col = p.columns[c];
    const canvas = document.createElement("canvas").getContext("2d")!;
    canvas.font = getComputedStyle(scroller.current ?? document.body).font || "12px Segoe UI";
    let max = canvas.measureText(col.label).width + 24;
    const sample = Math.min(order.length, 1000);
    for (let i = 0; i < sample; i++) max = Math.max(max, canvas.measureText(shown(c, p.getValue(order[i], c))).width + (col.lookup ? 30 : 16));
    const next = { ...widthsRef.current, [col.key]: Math.round(Math.max(40, Math.min(600, max))) };
    setWidths(next);
    p.onWidthsChange?.(next);
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(totalRows, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const visible = [];
  for (let r = first; r < last; r++) visible.push(r);

  const defaultWidth = (col: DatasheetColumn) => {
    const t = col.field?.type;
    if (t === "YesNo") return 70;
    if (t === "AutoNumber" || t === "Number") return 90;
    if (t === "Currency" || t === "DateTime") return 110;
    if (t === "LongText") return 240;
    return Math.max(110, Math.min(220, col.label.length * 9 + 30));
  };

  const recordLabel = isNewRow(cell.r) ? count + 1 : count ? cell.r + 1 : 0;

  return (
    <div className="datasheet-wrap">
      <div
        className="datasheet-scroll"
        ref={scroller}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <table
          className={`datasheet ${customH ? "custom-h" : ""} ${tall ? "tall" : ""}`}
          style={{ width: "max-content", ...(customH ? ({ "--ds-row-h": `${ROW_H}px` } as React.CSSProperties) : {}) }}
        >
          <colgroup>
            <col style={{ width: 22 }} />
            {p.columns.map((col) => (
              <col key={col.key} style={{ width: widths[col.key] ?? defaultWidth(col) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="corner" onClick={() => setSelRows(new Set(order.map((_, i) => i)))} title="Select all records" />
              {p.columns.map((col, c) => (
                <th
                  key={col.key}
                  className={c === cell.c ? "col-active" : undefined}
                  onClick={() => moveTo(cell.r, c, true)}
                  title={col.field?.description || col.label}
                >
                  <span className="th-label">{col.label}</span>
                  {sort?.col === c && <span className="sort-arrow">{sort.dir === "ASC" ? "▲" : "▼"}</span>}
                  <span
                    className="col-resizer"
                    title="Drag to resize; double-click to fit"
                    onPointerDown={(e) => startResize(e, col.key)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      bestFit(c);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {first > 0 && (
              <tr style={{ height: first * ROW_H }} aria-hidden>
                <td colSpan={colCount + 1} className="spacer" />
              </tr>
            )}
            {visible.map((r) => {
              const newRow = isNewRow(r);
              const current = r === cell.r;
              const rowSel = selRows.has(r);
              return (
                <tr key={newRow ? "__new" : p.rowKey(order[r])} className={`${current ? "row-current" : ""} ${rowSel ? "row-selected" : ""}`}>
                  <td
                    className="row-selector"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      if (!moveTo(r, cell.c, true)) return;
                      setSelRows((prev) => {
                        if (e.shiftKey && prev.size) {
                          const anchor = Math.min(...prev);
                          const s = new Set<number>();
                          for (let i = Math.min(anchor, r); i <= Math.max(anchor, r); i++) if (i < count) s.add(i);
                          return s;
                        }
                        if (e.ctrlKey || e.metaKey) {
                          const s = new Set(prev);
                          if (s.has(r)) s.delete(r);
                          else if (r < count) s.add(r);
                          return s;
                        }
                        return r < count ? new Set([r]) : new Set();
                      });
                      scroller.current?.focus();
                    }}
                  >
                    {newRow ? "*" : current ? (editing ? "✎" : "▶") : ""}
                    {p.onRowHeightChange && (
                      <span
                        className="row-resizer"
                        title="Drag to change the row height; double-click for standard height"
                        onMouseDown={(e) => e.stopPropagation()}
                        onPointerDown={startRowResize}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          if (p.rowHeight !== undefined) p.onRowHeightChange?.(undefined);
                        }}
                      />
                    )}
                  </td>
                  {p.columns.map((col, c) => {
                    const active = current && c === cell.c;
                    const v = newRow ? null : p.getValue(order[r], c);
                    const type = col.field?.type;
                    const cls = [
                      active ? "cell-active" : "",
                      isNumericType(type) && !col.lookup ? "num" : "",
                      type === "YesNo" ? "center" : "",
                      !newRow && p.cellWarning?.(order[r], c) ? "cell-warning" : "",
                    ].join(" ");
                    if (active && editing && col.lookup) {
                      const matches = lookupMatches(c, editing.text, editing.typed);
                      const hi = Math.min(editing.hi ?? 0, Math.max(0, matches.length - 1));
                      const pick = (o: { value: string; label: string }) => {
                        if (commit(o.value)) scroller.current?.focus();
                      };
                      return (
                        <td key={col.key} className={`${cls} editing lookup-cell ${error ? "has-error" : ""}`}>
                          <input
                            ref={editorRef}
                            className="cell-editor"
                            value={editing.text}
                            aria-label={col.label}
                            role="combobox"
                            aria-expanded={!!editing.list}
                            aria-autocomplete="list"
                            onChange={(e) => {
                              setEditing({ text: e.target.value, list: true, typed: true, hi: 0 });
                              setError(null);
                            }}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              const open = editing.list;
                              if ((e.altKey && e.key === "ArrowDown") || e.key === "F4") {
                                e.preventDefault();
                                setEditing({ ...editing, list: !open, typed: false, hi: Math.max(0, (col.lookup!.options ?? []).findIndex((o) => o.label === editing.text)) });
                              } else if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                                e.preventDefault();
                                const n = Math.max(0, Math.min(matches.length - 1, hi + (e.key === "ArrowDown" ? 1 : -1)));
                                setEditing({ ...editing, hi: n });
                                listRef.current?.children[n]?.scrollIntoView({ block: "nearest" });
                              } else if (open && e.key === "Escape") {
                                e.preventDefault();
                                setEditing({ ...editing, list: false });
                              } else if (open && e.key === "Enter" && matches[hi]) {
                                // Take the highlighted choice, then move on like Enter does.
                                e.preventDefault();
                                const wasNew = isNewRow(cell.r);
                                if (!commit(matches[hi].value)) return;
                                if (cell.c < colCount - 1) setCell({ r: wasNew ? count : cell.r, c: cell.c + 1 });
                                else setCell({ r: wasNew ? count + 1 : Math.min(cell.r + 1, totalRows - 1), c: firstEditableCol() });
                                scroller.current?.focus();
                              } else onKeyDown(e);
                            }}
                            onBlur={(e) => {
                              if (!scroller.current?.contains(e.relatedTarget as Node) && !listRef.current?.contains(e.relatedTarget as Node)) commit();
                            }}
                          />
                          <button
                            className="lookup-arrow"
                            tabIndex={-1}
                            aria-label={`Open ${col.label} list`}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              setEditing({ ...editing, list: !editing.list, typed: false });
                            }}
                          >
                            ▾
                          </button>
                          {editing.list && (
                            <LookupList
                              anchor={editorRef}
                              listRef={listRef}
                              options={matches}
                              hi={hi}
                              current={editing.text}
                              loading={col.lookup.loading}
                              onHover={(i) => setEditing({ ...editing, hi: i })}
                              onPick={pick}
                            />
                          )}
                        </td>
                      );
                    }
                    if (active && editing) {
                      return (
                        <td key={col.key} className={`${cls} editing ${error ? "has-error" : ""}`}>
                          <input
                            ref={editorRef}
                            className="cell-editor"
                            enterKeyHint="next"
                            value={editing.text}
                            aria-label={col.label}
                            onChange={(e) => {
                              setEditing({ text: e.target.value });
                              setError(null);
                            }}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              onKeyDown(e);
                            }}
                            onBlur={(e) => {
                              // Commit when focus leaves the grid entirely (e.g. clicking the ribbon).
                              if (!scroller.current?.contains(e.relatedTarget as Node)) commit();
                            }}
                          />
                        </td>
                      );
                    }
                    return (
                      <td
                        key={col.key}
                        className={cls}
                        onMouseDown={(e) => {
                          wasActive.current = active;
                          if (active) return;
                          e.preventDefault();
                          moveTo(r, c);
                          scroller.current?.focus();
                        }}
                        onDoubleClick={() => !touch && startEdit()}
                        onClick={() => {
                          if (active && type === "YesNo") toggle();
                          else if (touch && active && wasActive.current) startEdit();
                        }}
                      >
                        {type === "YesNo" ? (
                          <input type="checkbox" tabIndex={-1} readOnly checked={v === true || v === 1} className="cell-check" />
                        ) : newRow ? (
                          <span className="placeholder">{p.newRowPlaceholder?.(c) ?? ""}</span>
                        ) : tall ? (
                          <div className="cell-wrap">{shown(c, v)}</div>
                        ) : (
                          shown(c, v)
                        )}
                        {active && col.lookup && canEdit(c) && (
                          // Like Access, the current cell of a lookup shows its drop-down arrow.
                          <button
                            className="lookup-arrow"
                            tabIndex={-1}
                            aria-label={`Open ${col.label} list`}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              startEdit(undefined, true);
                            }}
                          >
                            ▾
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {last < totalRows && (
              <tr style={{ height: (totalRows - last) * ROW_H }} aria-hidden>
                <td colSpan={colCount + 1} className="spacer" />
              </tr>
            )}
          </tbody>
        </table>
        {count === 0 && !allowNew && <div className="empty-note">{p.emptyMessage ?? "No records."}</div>}
      </div>
      <div className="record-nav">
        <span className="rn-label">Record:</span>
        <button onClick={() => navTo(0)} title="First record" disabled={!count}>⏮</button>
        <button onClick={() => navTo(cell.r - 1)} title="Previous record" disabled={cell.r <= 0}>◀</button>
        <input
          className="rn-pos"
          value={`${recordLabel} of ${count}`}
          onFocus={(e) => (e.target.value = String(recordLabel))}
          onBlur={(e) => (e.target.value = `${recordLabel} of ${count}`)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const n = Number((e.target as HTMLInputElement).value);
              if (n >= 1 && n <= count) navTo(n - 1);
              else scroller.current?.focus();
            }
          }}
          aria-label="Current record"
        />
        <button onClick={() => navTo(cell.r + 1)} title="Next record" disabled={cell.r >= totalRows - 1}>▶</button>
        <button onClick={() => navTo(count - 1)} title="Last record" disabled={!count}>⏭</button>
        {allowNew && (
          <button onClick={() => navTo(count)} title="New (blank) record">▶*</button>
        )}
        <span className={`rn-filter ${filter ? "on" : ""}`}>{filter ? "Filtered" : "No Filter"}</span>
        <label className="rn-search">
          <FindIcon size={12} />
          <input
            ref={findBox}
            placeholder="Search"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setCell((c) => ({ ...c, r: 0 }));
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setFilter("");
              if (e.key === "Enter") scroller.current?.focus();
            }}
          />
        </label>
      </div>
    </div>
  );
});

/** A lookup's drop-down, drawn at page level under the cell so the grid can't clip it. */
function LookupList(props: {
  /** The cell editor; read once it's on the page. */
  anchor: React.RefObject<HTMLElement | null>;
  listRef: React.RefObject<HTMLDivElement | null>;
  options: { value: string; label: string }[];
  hi: number;
  current: string;
  loading?: boolean;
  onHover: (i: number) => void;
  onPick: (o: { value: string; label: string }) => void;
}) {
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    const td = props.anchor.current?.closest("td");
    if (!td) return;
    const r = td.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 8;
    setPos({ left: r.left, top: r.bottom, width: Math.max(r.width, 180), maxHeight: Math.max(120, Math.min(260, below)) });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    props.listRef.current?.children[props.hi]?.scrollIntoView({ block: "nearest" });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pos) return null;
  return createPortal(
    <div ref={props.listRef} className="combo-list lookup-list" role="listbox" style={{ position: "fixed", left: pos.left, top: pos.top, minWidth: pos.width, maxHeight: pos.maxHeight }}>
      {props.options.map((o, i) => (
        <div
          key={o.value}
          role="option"
          aria-selected={i === props.hi}
          className={`combo-option ${i === props.hi ? "highlight" : ""} ${o.label === props.current ? "selected" : ""}`}
          onMouseEnter={() => props.onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            props.onPick(o);
          }}
        >
          {o.label}
        </div>
      ))}
      {!props.options.length && <div className="combo-option muted">{props.loading ? "Loading…" : "(no matching items)"}</div>}
    </div>,
    document.body,
  );
}
