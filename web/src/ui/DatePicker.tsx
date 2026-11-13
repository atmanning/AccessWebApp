/**
 * The drop-down calendar for Date/Time fields (Access's date picker): a month of days, with
 * Today and Clear. It never takes the keyboard focus, so the text box stays the place you type;
 * while it's open, the box passes ← → ↑ ↓, Page Up/Down, Enter and Esc to it (see `handleKey`).
 */
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { parseAccessDate } from "../engine/accessSql";

export interface DatePickerHandle {
  /** Handles a key typed in the text box; true when the calendar used it. */
  handleKey: (e: { key: string; altKey: boolean; preventDefault: () => void }) => boolean;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

type Ymd = { y: number; m: number; d: number };
const today = (): Ymd => {
  const n = new Date();
  return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate() };
};
const same = (a: Ymd | null, b: Ymd) => !!a && a.y === b.y && a.m === b.m && a.d === b.d;
const addDays = (a: Ymd, n: number): Ymd => {
  const t = new Date(Date.UTC(a.y, a.m - 1, a.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const addMonths = (a: Ymd, n: number): Ymd => {
  const total = a.y * 12 + a.m - 1 + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { y, m, d: Math.min(a.d, last) };
};

/** The date (and any time) in a box's text. */
function parse(text: string): { date: Ymd; time: string } | null {
  const iso = parseAccessDate(text);
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  // Keep the time part as it was typed (e.g. "2:30 PM").
  const t = /\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\s*$/i.exec(text.trim());
  return { date: { y, m, d }, time: t ? t[1] : "" };
}

/** A picked day as the text Access shows: m/d/yyyy, keeping the time if there was one. */
export const dateText = (a: Ymd, time = "") => `${a.m}/${a.d}/${a.y}${time ? ` ${time}` : ""}`;

export const DatePicker = forwardRef<
  DatePickerHandle,
  {
    anchor: RefObject<HTMLElement | null>;
    /** The text in the box now. */
    value: string;
    onPick: (text: string) => void;
    onClear: () => void;
    onClose: () => void;
  }
>(function DatePicker(props, ref) {
  const current = parse(props.value);
  const [focus, setFocus] = useState<Ymd>(current?.date ?? today());
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const pick = (a: Ymd) => props.onPick(dateText(a, current?.time));

  useLayoutEffect(() => {
    const place = () => {
      const a = props.anchor.current?.getBoundingClientRect();
      const b = box.current;
      if (!a || !b) return;
      const h = b.offsetHeight;
      const w = b.offsetWidth;
      const below = a.bottom + 2 + h <= window.innerHeight;
      setPos({
        left: Math.max(4, Math.min(a.left, window.innerWidth - w - 4)),
        top: below ? a.bottom + 2 : Math.max(4, a.top - h - 2),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    // Clicking anywhere else closes it.
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node) && !props.anchor.current?.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener("pointerdown", away, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("pointerdown", away, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    handleKey: (e) => {
      const move = (n: Ymd) => {
        e.preventDefault();
        setFocus(n);
        return true;
      };
      switch (e.key) {
        case "ArrowLeft":
          return move(addDays(focus, -1));
        case "ArrowRight":
          return move(addDays(focus, 1));
        case "ArrowUp":
          return e.altKey ? (e.preventDefault(), props.onClose(), true) : move(addDays(focus, -7));
        case "ArrowDown":
          return move(addDays(focus, 7));
        case "PageUp":
          return move(addMonths(focus, -1));
        case "PageDown":
          return move(addMonths(focus, 1));
        case "Home":
          return move({ ...focus, d: 1 });
        case "End":
          return move({ ...focus, d: new Date(Date.UTC(focus.y, focus.m, 0)).getUTCDate() });
        case "Enter":
        case " ":
          e.preventDefault();
          pick(focus);
          return true;
        case "Escape":
        case "Tab":
          if (e.key === "Escape") e.preventDefault();
          props.onClose();
          return e.key === "Escape";
        case "F4":
          e.preventDefault();
          props.onClose();
          return true;
      }
      return false;
    },
  }));

  // The six weeks shown: starting on the Sunday on or before the 1st.
  const first = { y: focus.y, m: focus.m, d: 1 };
  const start = addDays(first, -new Date(Date.UTC(focus.y, focus.m - 1, 1)).getUTCDay());
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const now = today();

  return createPortal(
    <div
      ref={box}
      className="date-picker"
      role="dialog"
      aria-label="Choose a date"
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden", left: 0, top: 0 }}
      // Keep the focus (and the caret) in the text box.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="dp-head">
        <button type="button" tabIndex={-1} aria-label="Previous month" onClick={() => setFocus(addMonths(focus, -1))}>
          ‹
        </button>
        <span className="dp-title">
          {MONTHS[focus.m - 1]} {focus.y}
        </span>
        <button type="button" tabIndex={-1} aria-label="Next month" onClick={() => setFocus(addMonths(focus, 1))}>
          ›
        </button>
      </div>
      <div className="dp-grid" role="grid">
        {DOW.map((d) => (
          <span key={d} className="dp-dow">
            {d}
          </span>
        ))}
        {days.map((a) => (
          <button
            key={`${a.y}-${a.m}-${a.d}`}
            type="button"
            tabIndex={-1}
            role="gridcell"
            aria-selected={same(current?.date ?? null, a)}
            aria-label={`${MONTHS[a.m - 1]} ${a.d}, ${a.y}`}
            className={`dp-day ${a.m !== focus.m ? "other" : ""} ${same(now, a) ? "today" : ""} ${same(current?.date ?? null, a) ? "sel" : ""} ${same(focus, a) ? "focus" : ""}`}
            onClick={() => pick(a)}
          >
            {a.d}
          </button>
        ))}
      </div>
      <div className="dp-foot">
        <button type="button" tabIndex={-1} onClick={() => pick(now)}>
          Today
        </button>
        <button type="button" tabIndex={-1} onClick={props.onClear}>
          Clear
        </button>
      </div>
    </div>,
    document.body,
  );
});

/** The little calendar button at the right of a date box. */
export function CalendarButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      className="dp-button"
      tabIndex={-1}
      aria-label={`Choose a date for ${label}`}
      title="Choose a date (Alt+↓)"
      onMouseDown={(e) => {
        // Don't take the focus from the box.
        e.preventDefault();
        onClick();
      }}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="12" rx="1.5" fill="#fff" stroke="currentColor" />
        <path d="M1.5 6h13" stroke="currentColor" />
        <path d="M5 1v3M11 1v3" stroke="currentColor" strokeLinecap="round" />
        <rect x="4" y="8" width="2" height="2" fill="currentColor" />
        <rect x="7" y="8" width="2" height="2" fill="currentColor" />
        <rect x="10" y="8" width="2" height="2" fill="currentColor" />
        <rect x="4" y="11" width="2" height="2" fill="currentColor" />
      </svg>
    </button>
  );
}
