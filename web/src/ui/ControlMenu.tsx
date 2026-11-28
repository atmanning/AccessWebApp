/**
 * The menu for a control in a designer: a long press on a phone or tablet (a sheet at the bottom),
 * or a right-click with a mouse. Edit its text (a label's or button's caption), rename it, or delete it.
 */
import { useEffect, useRef } from "react";
import { useLayout } from "./layout";

export interface ControlMenuItem {
  label: string;
  run: () => void;
  danger?: boolean;
}

export function ControlMenu(props: { x: number; y: number; title: string; items: ControlMenuItem[]; onClose: () => void }) {
  const { compact } = useLayout();
  const opened = useRef(Date.now());
  useEffect(() => {
    // Ignore the mouse event some phones send as a long press ends.
    const close = () => Date.now() - opened.current > 400 && props.onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", key);
    };
  }, [props]);
  return (
    <div
      className={`context-menu ${compact ? "sheet" : ""}`}
      style={compact ? undefined : { left: Math.max(0, Math.min(props.x, window.innerWidth - 230)), top: Math.max(0, Math.min(props.y, window.innerHeight - props.items.length * 30 - 40)) }}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      role="menu"
      aria-label={props.title}
    >
      <div className="menu-title">{props.title}</div>
      {props.items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className={item.danger ? "menu-danger" : ""}
          onClick={() => {
            props.onClose();
            item.run();
          }}
        >
          <span>{item.label}</span>
        </button>
      ))}
      {compact && (
        <button role="menuitem" className="menu-cancel" onClick={props.onClose}>
          Cancel
        </button>
      )}
    </div>
  );
}
