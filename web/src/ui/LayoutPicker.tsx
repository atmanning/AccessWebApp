import { LAYOUT_LABELS, setLayoutPref, useLayout, type LayoutPref } from "./layout";

/** Automatic / Phone / Desktop layout choice, remembered in this browser. */
export function LayoutPicker({ className }: { className?: string }) {
  const { pref, compact } = useLayout();
  return (
    <label className={`layout-picker ${className ?? ""}`} title="Phone layout: collapsed ribbon, navigation drawer, larger touch targets">
      <span>Layout</span>
      <select value={pref} onChange={(e) => setLayoutPref(e.target.value as LayoutPref)} aria-label="Screen layout">
        {(Object.keys(LAYOUT_LABELS) as LayoutPref[]).map((p) => (
          <option key={p} value={p}>
            {LAYOUT_LABELS[p]}
            {p === "auto" ? ` (${compact && pref === "auto" ? "phone" : pref === "auto" ? "desktop" : "detect"})` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
