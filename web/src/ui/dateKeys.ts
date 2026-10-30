/**
 * Access shortcuts: Ctrl+; enters the current date, Ctrl+Shift+; (Ctrl+:) the current time.
 */
import type { FieldType } from "../../../shared/model";

export type DateShortcut = "date" | "time";

export function dateShortcut(e: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): DateShortcut | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const semicolonKey = e.code === "Semicolon" || e.key === ";" || e.key === ":";
  if (!semicolonKey) return null;
  return e.shiftKey || e.key === ":" ? "time" : "date";
}

/** Today as m/d/yyyy, or the time as h:mm AM/PM — the forms Access types for you. */
export function nowText(kind: DateShortcut, now = new Date()): string {
  if (kind === "date") return `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
  const h = now.getHours();
  return `${h % 12 || 12}:${String(now.getMinutes()).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

/** Field types where a typed date or time makes sense. */
export function acceptsDateText(type: FieldType | undefined): boolean {
  return type === "DateTime" || type === "ShortText" || type === "LongText";
}

/** Inserts text at the caret of an input/textarea in a way React's onChange notices. */
export function insertAtCaret(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.setRangeText(text, start, end, "end");
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** True for editable text boxes (not checkboxes, number spinners, read-only or disabled fields). */
export function isTextBox(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  return el instanceof HTMLInputElement && ["text", "search", ""].includes(el.type) && !el.readOnly && !el.disabled;
}
