import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

export interface ComboOption<T extends string> {
  value: T;
  label: string;
}

/**
 * An Access-style combo box for grids and property sheets:
 * - double-click cycles to the next choice (wrapping around), like Access;
 * - the ▾ button, F4, Alt+↓ or Space opens the list;
 * - ↑/↓ change the value directly, typing a letter jumps to a matching choice.
 * The list is drawn at page level so grids and panes can't clip it.
 */
export function ComboBox<T extends string>(props: {
  value: T;
  options: ComboOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  /** Shown when the value isn't one of the options (e.g. empty). */
  placeholder?: string;
  onFocus?: () => void;
}) {
  const { value, options, onChange, disabled } = props;
  const [open, setOpenState] = useState(false);
  const [highlight, setHighlightState] = useState(0);
  // Refs mirror the state so key presses that arrive before a re-render still see it.
  const openRef = useRef(false);
  const highlightRef = useRef(0);
  const setOpen = (v: boolean) => {
    openRef.current = v;
    setOpenState(v);
  };
  const setHighlight = (v: number | ((h: number) => number)) => {
    highlightRef.current = typeof v === "function" ? v(highlightRef.current) : v;
    setHighlightState(highlightRef.current);
  };
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const index = options.findIndex((o) => o.value === value);
  const current = options[index];

  const choose = (i: number) => {
    const o = options[(i + options.length) % options.length];
    if (o && o.value !== value) onChange(o.value);
  };

  const openList = () => {
    if (disabled || !options.length) return;
    const r = box.current!.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 8;
    setPos({ left: r.left, top: r.bottom, width: Math.max(r.width, 120), maxHeight: Math.max(120, Math.min(260, below)) });
    setHighlight(Math.max(0, index));
    setOpen(true);
  };
  const close = () => setOpen(false);

  // Close when clicking elsewhere, scrolling or resizing.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !box.current?.contains(e.target as Node)) close();
    };
    const onScroll = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-i="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (disabled) return;
    if (openRef.current) {
      if (e.key === "ArrowDown") setHighlight((h) => Math.min(options.length - 1, h + 1));
      else if (e.key === "ArrowUp") setHighlight((h) => Math.max(0, h - 1));
      else if (e.key === "Enter" || e.key === "Tab") {
        choose(highlightRef.current);
        close();
        if (e.key === "Tab") return; // let focus move on
      } else if (e.key === "Escape") close();
      else return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === "F4" || (e.altKey && e.key === "ArrowDown") || e.key === " ") openList();
    else if (e.key === "ArrowDown") choose(Math.min(options.length - 1, Math.max(0, index + 1)));
    else if (e.key === "ArrowUp") choose(Math.max(0, index - 1));
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey) {
      // Jump to the next choice starting with the typed letter.
      const k = e.key.toLowerCase();
      for (let step = 1; step <= options.length; step++) {
        const i = (Math.max(index, 0) + step) % options.length;
        if (options[i].label.toLowerCase().startsWith(k)) {
          choose(i);
          break;
        }
      }
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={box}
      className={`combo ${disabled ? "disabled" : ""} ${props.className ?? ""}`}
      role="combobox"
      tabIndex={disabled ? -1 : 0}
      aria-label={props.ariaLabel}
      aria-expanded={open}
      aria-disabled={disabled}
      title={disabled ? undefined : "Double-click to cycle through the choices"}
      onKeyDown={onKeyDown}
      onFocus={props.onFocus}
      onDoubleClick={(e) => {
        if (disabled || (e.target as HTMLElement).closest(".combo-arrow")) return;
        e.preventDefault();
        choose(index + 1);
        close();
      }}
      onMouseDown={(e) => {
        // Don't select the text on double-click.
        if (e.detail > 1) e.preventDefault();
      }}
    >
      <span className={`combo-text ${current ? "" : "placeholder"}`}>{current?.label ?? props.placeholder ?? ""}</span>
      <button
        type="button"
        className="combo-arrow"
        tabIndex={-1}
        disabled={disabled}
        aria-label={`Open ${props.ariaLabel} list`}
        onMouseDown={(e) => {
          e.preventDefault();
          box.current?.focus();
          if (open) close();
          else openList();
        }}
      >
        ▾
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={list}
            className="combo-list"
            role="listbox"
            aria-label={props.ariaLabel}
            style={{ left: pos.left, top: pos.top, minWidth: pos.width, maxHeight: pos.maxHeight }}
          >
            {options.map((o, i) => (
              <div
                key={o.value}
                data-i={i}
                role="option"
                aria-selected={o.value === value}
                className={`combo-option ${i === highlight ? "highlight" : ""} ${o.value === value ? "selected" : ""}`}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(i);
                  close();
                  box.current?.focus();
                }}
              >
                {o.label || " "}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
