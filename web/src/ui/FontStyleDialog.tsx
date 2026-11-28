/**
 * A designer control's text and its look, in one place for phones (long press → Font & Style):
 * the words it shows, the font, size, bold / italic / underline, alignment and color. Changes show
 * on the control as they're made; Ctrl+Z undoes them.
 */
import { useState } from "react";
import { FONT_CHOICES, fontStack, type FormControl } from "../../../shared/model";
import { Modal } from "./dialogs";

type Style = Pick<FormControl, "caption" | "label" | "font" | "fontSize" | "bold" | "italic" | "underline" | "align" | "color">;
/** What the dialog needs of a form's or report's control. */
type Styled = Style & Pick<FormControl, "type" | "name" | "field" | "labelPos">;

/** The words a control shows: a label's, button's or check box's caption, or a bound box's own label. */
export function textOf(c: Styled): { key: "caption" | "label"; value: string } | null {
  if (c.type === "label" || c.type === "button" || c.type === "checkbox") return { key: "caption", value: c.caption ?? "" };
  if ((c.type === "textbox" || c.type === "combobox" || c.type === "listbox" || c.type === "subform") && (c.labelPos ?? "top") !== "none") return { key: "label", value: c.label ?? c.field ?? "" };
  return null;
}

export function FontStyleDialog({ control, baseSize = 13, onPatch, onClose }: { control: Styled; baseSize?: number; onPatch: (patch: Partial<Style>) => void; onClose: () => void }) {
  const text = textOf(control);
  const [draft, setDraft] = useState(text?.value ?? "");
  const size = control.fontSize ?? baseSize;
  const set = (patch: Partial<Style>) => onPatch(patch);
  const commitText = () => text && draft !== text.value && set({ [text.key]: draft.slice(0, text.key === "caption" ? 500 : 200) });
  return (
    <Modal
      title="Font & Style"
      width={380}
      onClose={() => (commitText(), onClose())}
      footer={
        <button className="primary" onClick={() => (commitText(), onClose())}>
          Done
        </button>
      }
    >
      <div className="font-style">
        {text && (
          <label className="fs-row fs-text">
            <span>{text.key === "caption" ? "Text" : "Label"}</span>
            <input className="text-input" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commitText} />
          </label>
        )}
        <label className="fs-row">
          <span>Font</span>
          <select value={control.font ?? ""} onChange={(e) => set({ font: e.target.value || undefined })}>
            <option value="">Default</option>
            {Object.keys(FONT_CHOICES).map((f) => (
              <option key={f} value={f} style={{ fontFamily: fontStack(f) }}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <div className="fs-row">
          <span>Size</span>
          <div className="fs-stepper">
            <button type="button" aria-label="Smaller" onClick={() => set({ fontSize: Math.max(8, size - 1) })}>
              A−
            </button>
            <input
              type="number"
              min={8}
              max={72}
              value={size}
              aria-label="Font size"
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (n >= 8 && n <= 72) set({ fontSize: n });
              }}
            />
            <button type="button" aria-label="Larger" onClick={() => set({ fontSize: Math.min(72, size + 1) })}>
              A+
            </button>
          </div>
        </div>
        <div className="fs-row">
          <span>Style</span>
          <div className="fs-toggles" role="group" aria-label="Text style">
            <button type="button" className={control.bold ? "on" : ""} aria-pressed={!!control.bold} onClick={() => set({ bold: !control.bold || undefined })} title="Bold">
              <b>B</b>
            </button>
            <button type="button" className={control.italic ? "on" : ""} aria-pressed={!!control.italic} onClick={() => set({ italic: !control.italic || undefined })} title="Italic">
              <i>I</i>
            </button>
            <button type="button" className={control.underline ? "on" : ""} aria-pressed={!!control.underline} onClick={() => set({ underline: !control.underline || undefined })} title="Underline">
              <u>U</u>
            </button>
          </div>
        </div>
        <div className="fs-row">
          <span>Align</span>
          <div className="fs-toggles" role="group" aria-label="Alignment">
            {(["left", "center", "right"] as const).map((a) => (
              <button key={a} type="button" className={(control.align ?? "left") === a ? "on" : ""} aria-pressed={(control.align ?? "left") === a} onClick={() => set({ align: a === "left" ? undefined : a })} title={a[0].toUpperCase() + a.slice(1)}>
                <AlignIcon a={a} />
              </button>
            ))}
          </div>
        </div>
        <div className="fs-row">
          <span>Color</span>
          <div className="fs-color">
            <input type="color" aria-label="Text color" value={control.color ?? "#000000"} onChange={(e) => set({ color: e.target.value })} />
            {control.color ? (
              <button type="button" className="link" onClick={() => set({ color: undefined })}>
                Automatic
              </button>
            ) : (
              <span className="muted small">Automatic</span>
            )}
          </div>
        </div>
        <div
          className="fs-preview"
          style={{
            fontFamily: fontStack(control.font),
            fontSize: size,
            fontWeight: control.bold ? 700 : undefined,
            fontStyle: control.italic ? "italic" : undefined,
            textDecoration: control.underline ? "underline" : undefined,
            textAlign: control.align ?? "left",
            color: control.color,
          }}
        >
          {draft || control.name}
        </div>
      </div>
    </Modal>
  );
}

function AlignIcon({ a }: { a: "left" | "center" | "right" }) {
  const lines = [14, 9, 14, 9];
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
      {lines.map((w, i) => {
        const x = a === "left" ? 1 : a === "right" ? 15 - w : (16 - w) / 2;
        return <rect key={i} x={x} y={1 + i * 3.3} width={w} height="1.6" rx="0.8" fill="currentColor" />;
      })}
    </svg>
  );
}
