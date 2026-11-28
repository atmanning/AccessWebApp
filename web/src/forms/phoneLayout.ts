/**
 * A form designed for a desktop screen, rearranged for a phone: one column, read top to bottom.
 *
 * Access forms put a label beside (or above) each box, buttons in the header with a small picture
 * on (or beside) each one, and often an invisible button over a picture (a search icon). On a
 * phone the label goes above its box, a button's picture goes inside it, buttons share a row,
 * and a box with buttons beside it (a search box and its Go button) stays on one line.
 */
import type { FormControl } from "../../../shared/model";

/** One control as a phone shows it: with the caption of its label, and its button's picture. */
export interface PhoneItem {
  c: FormControl;
}

export type PhoneRow =
  /** A field (with its label above), a title, a picture, a subform… across the screen. */
  | { kind: "block"; item: PhoneItem }
  /** Buttons side by side. */
  | { kind: "buttons"; items: PhoneItem[] }
  /** A box with buttons beside it, like a search box and its Go button. */
  | { kind: "inline"; items: PhoneItem[] };

const BOUND = new Set(["textbox", "combobox", "listbox", "checkbox", "subform"]);
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const area = (c: FormControl) => c.w * c.h;
const intersect = (a: FormControl, b: FormControl) => overlap(a.x, a.x + a.w, b.x, b.x + b.w) * overlap(a.y, a.y + a.h, b.y, b.y + b.h);
const sameRow = (a: FormControl, b: FormControl) => overlap(a.y, a.y + a.h, b.y, b.y + b.h) >= Math.min(a.h, b.h) * 0.5;

/** A small picture (an icon), not a photo or a logo. */
const isIcon = (c: FormControl) => c.type === "image" && !c.field && !!c.picture && c.w <= 64 && c.h <= 64;

/** The largest font a phone shows: titles stay big, but not desktop-poster big. */
const MAX_FONT = 26;

/**
 * The controls of one section (already without hidden ones), arranged for a phone. Controls
 * marked "not on phones" are left out; so are lines and rectangles (they only decorate).
 */
/**
 * Which label belongs to which box (Access keeps them as separate controls): one named after it
 * ("City_Label"), or the one just left of it or just above it; a check box's is right of it.
 * Returns control id → label id.
 */
export function attachedLabels(controls: FormControl[]): Map<string, string> {
  const result = new Map<string, string>();
  const labels = controls.filter((c) => c.type === "label" && c.caption);
  const used = new Set<string>();
  const targets = controls.filter((c) => BOUND.has(c.type) || (c.type === "image" && !!c.field)).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const c of targets) {
    if (c.label && c.labelPos !== "none") continue;
    let best = labels.find((l) => !used.has(l.id) && l.section === c.section && l.name.toLowerCase() === `${c.name}_label`.toLowerCase());
    let bestGap = Infinity;
    if (!best) {
      for (const l of labels) {
        if (used.has(l.id) || l.section !== c.section) continue;
        let gap = Infinity;
        if (c.type === "checkbox" && sameRow(l, c) && l.x >= c.x && l.x - (c.x + c.w) < 60) gap = Math.max(0, l.x - (c.x + c.w));
        else if (sameRow(l, c) && l.x + l.w <= c.x + 8 && c.x - (l.x + l.w) < 80) gap = c.x - (l.x + l.w);
        else if (l.y + l.h <= c.y + 4 && c.y - (l.y + l.h) < 24 && Math.abs(l.x - c.x) < 24) gap = c.y - (l.y + l.h) + 10;
        if (gap < bestGap) [best, bestGap] = [l, gap];
      }
    }
    if (!best) continue;
    used.add(best.id);
    result.set(c.id, best.id);
  }
  return result;
}

export function phoneRows(controls: FormControl[]): PhoneRow[] {
  const all = controls.filter((c) => !c.phoneHidden && c.type !== "line" && c.type !== "rectangle");
  const out = new Map<string, FormControl>(all.map((c) => [c.id, { ...c }]));
  const drop = new Set<string>();

  // A button's picture: an icon on it, or just left of it on the same row.
  const buttons = all.filter((c) => c.type === "button");
  for (const img of all.filter(isIcon)) {
    let best: FormControl | undefined;
    let bestScore = 0;
    for (const b of buttons) {
      if (b.section !== img.section || out.get(b.id)!.picture) continue;
      const on = intersect(img, b) / area(img);
      const beside = sameRow(img, b) && img.x + img.w <= b.x + 6 && b.x - (img.x + img.w) < 12 ? 0.6 : 0;
      const score = Math.max(on, beside);
      if (score > bestScore && score >= 0.4) [best, bestScore] = [b, score];
    }
    if (best) {
      out.get(best.id)!.picture = img.picture;
      drop.add(img.id);
    }
  }
  // An invisible button over nothing shows nothing on a phone either; one over a picture shows the picture.
  for (const b of buttons) {
    const o = out.get(b.id)!;
    if (o.transparent) {
      if (o.picture) {
        o.transparent = false;
        o.caption = "";
      } else drop.add(b.id);
    }
  }

  // Labels: the one just left of a box (or just above it) becomes its caption; a check box's is right of it.
  const labelOf = new Map(all.map((c) => [c.id, c]));
  for (const [cid, lid] of attachedLabels(all)) {
    const c = labelOf.get(cid)!;
    const best = labelOf.get(lid)!;
    drop.add(best.id);
    const o = out.get(c.id)!;
    if (c.type === "checkbox") o.caption = best.caption;
    else {
      o.label = best.caption;
      o.labelPos = "top";
    }
  }

  const items = all.filter((c) => !drop.has(c.id)).map((c) => out.get(c.id)!);
  for (const o of items) {
    // Phones size text themselves (16px boxes, so iPhones don't zoom in); only labels keep theirs, within reason.
    if (o.type === "label") {
      if (o.fontSize && o.fontSize > MAX_FONT) o.fontSize = MAX_FONT;
    } else delete o.fontSize;
  }

  // Rows: controls whose heights overlap, read left to right; rows top to bottom.
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: FormControl[][] = [];
  for (const c of sorted) {
    const row = rows.find((r) => r.some((x) => sameRow(x, c)));
    if (row) row.push(c);
    else rows.push([c]);
  }
  rows.sort((a, b) => Math.min(...a.map((c) => c.y)) - Math.min(...b.map((c) => c.y)));

  const result: PhoneRow[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    const btns = row.filter((c) => c.type === "button");
    if (btns.length === row.length) {
      result.push({ kind: "buttons", items: btns.map((c) => ({ c })) });
      continue;
    }
    // Left to right: a box followed by picture-only buttons stays on one line (search box, Go, Clear);
    // other buttons of the row go together after the rest.
    const later: FormControl[] = [];
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (c.type === "button") {
        later.push(c);
        continue;
      }
      if (c.type === "textbox" || c.type === "combobox") {
        const icons: FormControl[] = [];
        while (row[i + 1]?.type === "button" && !row[i + 1].caption && row[i + 1].picture) icons.push(row[++i]);
        if (icons.length) {
          result.push({ kind: "inline", items: [c, ...icons].map((x) => ({ c: x })) });
          continue;
        }
      }
      result.push({ kind: "block", item: { c } });
    }
    if (later.length) result.push({ kind: "buttons", items: later.map((c) => ({ c })) });
  }
  // Neighbouring button rows join into one (they wrap on the screen).
  const merged: PhoneRow[] = [];
  for (const r of result) {
    const last = merged[merged.length - 1];
    if (r.kind === "buttons" && last?.kind === "buttons") last.items.push(...r.items);
    else merged.push(r);
  }
  return merged;
}
