import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CellValue, Field } from "../../../shared/model";
import { editText, formatValue, isNumericType } from "../engine/values";
import { acceptsDateText, dateShortcut, insertAtCaret, nowText, type DateShortcut } from "../ui/dateKeys";
import { FindIcon } from "../ui/icons";

export interface DatasheetColumn {
  key: string;
  label: string;
  field?: Field;
  readOnly?: boolean;
  /** Shown in the status bar when someone tries to type in a read-only column. */
  readOnlyReason?: string;
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

const ROW_H = 24;
const OVERSCAN = 10;

type Cell = { r: number; c: number }; // r is a display index; r === displayCount means the new-record row

export const Datasheet = forwardRef<DatasheetHandle, DatasheetProps>(function Datasheet(p, ref) {
  const [sort, setSort] = useState<{ col: number; dir: "ASC" | "DESC" } | null>(null);
  const [filter, setFilter] = useState("");
  // An empty table starts in the first field you can type in, like Access.
  const [cell, setCell] = useState<Cell>(() => ({
    r: 0,
    c: p.rowCount ? 0 : Math.max(0, p.columns.findIndex((c) => !c.readOnly && c.field?.type !== "AutoNumber")),
  }));
  const [selRows, setSelRows] = useState<Set<number>>(new Set()); // display indexes
  const [editing, setEditing] = useState<{ text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  const scroller = useRef<HTMLDivElement>(null);
  const findBox = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);

  // Display order: filter then sort, as indexes into the underlying rows.
  const order = useMemo(() => {
    let idx = Array.from({ length: p.rowCount }, (_, i) => i);
    const f = filter.trim().toLowerCase();
    if (f) {
      idx = idx.filter((r) =>
        p.columns.some((col, c) => formatValue(col.field, p.getValue(r, c)).toLowerCase().includes(f)),
      );
    }
    if (sort) {
      const col = p.columns[sort.col];
      const numeric = isNumericType(col?.field?.type);
      const dir = sort.dir === "ASC" ? 1 : -1;
      idx.sort((a, b) => {
        const va = p.getValue(a, sort.col);
        const vb = p.getValue(b, sort.col);
        if (va === null || va === undefined || va === "") return vb === null || vb === undefined || vb === "" ? 0 : -dir;
        if (vb === null || vb === undefined || vb === "") return dir;
        if (numeric || (typeof va === "number" && typeof vb === "number")) return (Number(va) - Number(vb)) * dir;
        return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" }) * dir;
      });
    }
    return idx;
    // getValue changes identity when data changes, so it's the right dependency.
  }, [p.rowCount, p.getValue, p.columns, sort, filter]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const startEdit = (initial?: string) => {
    if (!canEdit(cell.c)) {
      const col = p.columns[cell.c];
      if (col?.readOnly && col.readOnlyReason) p.onStatus?.(col.readOnlyReason, "error");
      else if (col?.field?.type === "AutoNumber" && p.editable) p.onStatus?.("This field is an AutoNumber; Access fills it in for you.");
      return;
    }
    const field = p.columns[cell.c].field;
    if (field?.type === "YesNo") return toggle();
    setEditing({ text: initial ?? (field ? editText(field, valueAt(cell.r, cell.c)) : String(valueAt(cell.r, cell.c) ?? "")) });
    setError(null);
  };

  /** Saves the editor's text. Returns false if the value was rejected. */
  function commit(): boolean {
    if (!editing) return true;
    const field = p.columns[cell.c]?.field;
    const original = isNewRow(cell.r) ? "" : field ? editText(field, valueAt(cell.r, cell.c)) : "";
    if (editing.text === original) {
      setEditing(null);
      return true;
    }
    if (isNewRow(cell.r) && editing.text === "") {
      setEditing(null);
      return true;
    }
    const err = p.onCommit?.(isNewRow(cell.r) ? "new" : order[cell.r], cell.c, editing.text) ?? null;
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
    if (k === "ArrowDown") moveTo(cell.r + 1, cell.c);
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

  // Column resizing.
  const startResize = (e: React.MouseEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const th = (e.target as HTMLElement).parentElement!;
    const startW = th.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => setWidths((w) => ({ ...w, [key]: Math.max(40, startW + ev.clientX - startX) }));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
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
        <table className="datasheet" style={{ width: "max-content" }}>
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
                  <span className="col-resizer" onMouseDown={(e) => startResize(e, col.key)} />
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
                  </td>
                  {p.columns.map((col, c) => {
                    const active = current && c === cell.c;
                    const v = newRow ? null : p.getValue(order[r], c);
                    const type = col.field?.type;
                    const cls = [
                      active ? "cell-active" : "",
                      isNumericType(type) ? "num" : "",
                      type === "YesNo" ? "center" : "",
                      !newRow && p.cellWarning?.(order[r], c) ? "cell-warning" : "",
                    ].join(" ");
                    if (active && editing) {
                      return (
                        <td key={col.key} className={`${cls} editing ${error ? "has-error" : ""}`}>
                          <input
                            ref={editorRef}
                            className="cell-editor"
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
                          if (active) return;
                          e.preventDefault();
                          moveTo(r, c);
                          scroller.current?.focus();
                        }}
                        onDoubleClick={() => startEdit()}
                        onClick={() => {
                          if (active && type === "YesNo") toggle();
                        }}
                      >
                        {type === "YesNo" ? (
                          <input type="checkbox" tabIndex={-1} readOnly checked={v === true || v === 1} className="cell-check" />
                        ) : newRow ? (
                          <span className="placeholder">{p.newRowPlaceholder?.(c) ?? ""}</span>
                        ) : (
                          formatValue(col.field, v)
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
