/**
 * Draws one form control. The same component draws it in Form View (live, bound to the current
 * record) and in Design View (a picture of the control showing its Control Source), so what you
 * design is what you get.
 */
import "./forms.css";
import { useState, type CSSProperties, type ReactNode } from "react";
import { ImageDialog } from "../views/ImageDialog";
import { pictureIn } from "../ui/images";
import type { CellValue, Field, FormControl } from "../../../shared/model";
import { editText, formatValue, isNumericType } from "../engine/values";
import { acceptsDateText } from "../ui/dateKeys";

export interface ChoiceOption {
  value: string;
  label: string;
}

export interface RunProps {
  value: CellValue;
  field?: Field;
  /** The control's field isn't in the record source. */
  missing?: boolean;
  readOnly: boolean;
  isNew: boolean;
  error?: string | null;
  options?: ChoiceOption[];
  onCommit: (input: string | boolean) => void;
  onAction: () => void;
  buttonDisabled?: boolean;
  /** Image controls: where a picture is, and how to store a new one. */
  imageUrl?: (imageId: string) => string;
  uploadImage?: (file: Blob) => Promise<string>;
  /** A calculated control's result (Control Source "=…"), shown read-only. */
  display?: { text: string; error?: string; numeric?: boolean };
}

/** Font, colour and border properties as CSS. */
export function textStyle(c: FormControl): CSSProperties {
  const s: CSSProperties = {};
  if (c.fontSize) s.fontSize = c.fontSize;
  if (c.bold) s.fontWeight = 600;
  if (c.italic) s.fontStyle = "italic";
  if (c.align) s.textAlign = c.align;
  if (c.color) s.color = c.color;
  return s;
}
function boxStyle(c: FormControl): CSSProperties {
  const s: CSSProperties = {};
  if (c.backColor) s.background = c.backColor;
  if (c.borderColor) s.borderColor = c.borderColor;
  if (c.borderWidth !== undefined) {
    s.borderWidth = c.borderWidth;
    s.borderStyle = c.borderWidth ? "solid" : "none";
  }
  if (c.radius !== undefined) s.borderRadius = c.radius;
  return s;
}

export function FormControlView({ c, run, inputId }: { c: FormControl; run?: RunProps; inputId?: string }) {
  const design = !run;
  const ts = textStyle(c);
  const bs = boxStyle(c);

  switch (c.type) {
    case "label":
      return (
        <div className="fc-label" style={{ ...ts, ...bs, justifyContent: c.align === "center" ? "center" : c.align === "right" ? "flex-end" : undefined }}>
          {c.caption || (design ? <em className="fc-muted">(empty label)</em> : "")}
        </div>
      );
    case "rectangle":
      return <div className="fc-rect" style={bs} />;
    case "line":
      return <div className={`fc-line ${c.w >= c.h ? "h" : "v"}`} style={{ background: c.borderColor ?? c.color }} />;
    case "button": {
      const variant = c.variant && c.variant !== "switch" ? c.variant : "primary";
      return (
        <button
          type="button"
          className={`fc-button ${variant}`}
          style={{ ...ts, ...bs }}
          tabIndex={design ? -1 : undefined}
          disabled={!design && run?.buttonDisabled}
          onClick={design ? undefined : run!.onAction}
        >
          {c.caption || "Button"}
        </button>
      );
    }
    case "checkbox": {
      const checked = run ? run.value === true || run.value === 1 : false;
      const sw = c.variant === "switch";
      return (
        <label className={`fc-check ${sw ? "switch" : ""}`} style={ts}>
          <input
            id={inputId}
            type="checkbox"
            checked={checked}
            disabled={design || run!.readOnly}
            tabIndex={design ? -1 : undefined}
            onChange={(e) => run?.onCommit(e.target.checked)}
          />
          <span className="fc-check-box" aria-hidden="true" />
          <span className="fc-check-text">{c.caption ?? c.field ?? ""}</span>
          {run?.missing && <span className="fc-error-text"> #Name?</span>}
        </label>
      );
    }
    default:
      return <BoundControl c={c} run={run} ts={ts} bs={bs} inputId={inputId} />;
  }
}

/** Text, combo and list boxes: an input with its label above or beside it. */
function BoundControl({ c, run, ts, bs, inputId }: { c: FormControl; run?: RunProps; ts: CSSProperties; bs: CSSProperties; inputId?: string }) {
  const pos = c.labelPos ?? "top";
  const labelText = c.label ?? c.field ?? "";
  const label =
    pos === "none" ? null : (
      <label className="fc-caption" htmlFor={inputId} style={pos === "left" ? { width: c.labelWidth ?? 110, flex: "none" } : undefined}>
        {labelText}
      </label>
    );
  return (
    <div className={`fc-bound ${pos === "left" ? "left" : ""} ${run?.error ? "has-error" : ""}`}>
      {label}
      <div className="fc-input-wrap">
        {run ? <LiveInput c={c} run={run} ts={ts} bs={bs} id={inputId} /> : <DesignInput c={c} ts={ts} bs={bs} />}
        {run?.error && <div className="fc-error">{run.error}</div>}
      </div>
    </div>
  );
}

function DesignInput({ c, ts, bs }: { c: FormControl; ts: CSSProperties; bs: CSSProperties }) {
  const src = c.field ? c.field : <em className="fc-muted">Unbound</em>;
  if (c.type === "image") {
    return (
      <div className="fc-input fc-image design" style={{ ...ts, ...bs }}>
        <span className="fc-image-icon" aria-hidden="true">🖼</span>
        <span className="fc-src">{src}</span>
      </div>
    );
  }
  if (c.type === "listbox") {
    return (
      <div className="fc-input fc-list" style={{ ...ts, ...bs }}>
        <div className="fc-list-item">{src}</div>
      </div>
    );
  }
  return (
    <div className={`fc-input ${c.multiline ? "multi" : ""} ${c.type === "combobox" ? "combo" : ""}`} style={{ ...ts, ...bs }}>
      <span className="fc-src">{src}</span>
      {c.type === "combobox" && <span className="fc-caret" aria-hidden="true">▾</span>}
    </div>
  );
}

function LiveInput({ c, run, ts, bs, id }: { c: FormControl; run: RunProps; ts: CSSProperties; bs: CSSProperties; id?: string }) {
  const { field, value } = run;
  const style = { ...ts, ...bs };
  if (run.missing) return <div className="fc-input readonly fc-error-text" style={style}>#Name?</div>;
  if (run.display) {
    const d = run.display;
    return (
      <div id={id} className={`fc-input readonly calculated ${c.multiline ? "multi" : ""} ${d.numeric ? "num" : ""} ${d.error ? "fc-error-text" : ""}`} style={style} tabIndex={-1} title={d.error ?? c.field}>
        {d.text}
      </div>
    );
  }
  if (c.type === "image") return <ImageInput c={c} run={run} style={style} id={id} />;
  const num = isNumericType(field?.type) ? "num" : "";

  if (c.type === "combobox" || c.type === "listbox") {
    const current = value === null || value === undefined ? "" : String(value);
    const opts: ChoiceOption[] = run.options ?? [];
    const all = current && !opts.some((o) => o.value === current) ? [{ value: current, label: field ? formatValue(field, value) : current }, ...opts] : opts;
    if (c.type === "listbox") {
      return (
        <div className="fc-input fc-list" role="listbox" id={id} aria-readonly={run.readOnly} tabIndex={run.readOnly ? -1 : 0} style={style}>
          {all.map((o) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === current}
              className={`fc-list-item ${o.value === current ? "selected" : ""}`}
              onClick={() => !run.readOnly && o.value !== current && run.onCommit(o.value)}
            >
              {o.label || " "}
            </div>
          ))}
          {!all.length && <div className="fc-list-item fc-muted">(no items)</div>}
        </div>
      );
    }
    return (
      <select id={id} className="fc-input combo" value={current} disabled={run.readOnly} style={style} onChange={(e) => run.onCommit(e.target.value)}>
        <option value="">{c.placeholder ?? ""}</option>
        {all.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  if (run.readOnly || !field) {
    let text: ReactNode = formatValue(field, value);
    if (run.isNew && field?.type === "AutoNumber") text = <span className="fc-muted">(New)</span>;
    return (
      <div id={id} className={`fc-input readonly ${c.multiline ? "multi" : ""} ${num}`} style={style} tabIndex={-1}>
        {text}
      </div>
    );
  }
  const initial = editText(field, value);
  if (c.multiline) {
    return (
      <textarea
        id={id}
        className="fc-input multi"
        data-accepts-date="true"
        defaultValue={initial}
        placeholder={c.placeholder}
        style={style}
        onBlur={(e) => e.target.value !== initial && run.onCommit(e.target.value)}
      />
    );
  }
  return (
    <input
      id={id}
      className={`fc-input ${num}`}
      data-accepts-date={String(acceptsDateText(field.type))}
      defaultValue={initial}
      placeholder={c.placeholder ?? (field.type === "DateTime" ? "m/d/yyyy" : undefined)}
      inputMode={isNumericType(field.type) ? "decimal" : undefined}
      enterKeyHint="next"
      style={style}
      onBlur={(e) => e.target.value !== initial && run.onCommit(e.target.value)}
    />
  );
}

/** An Image control: the record's picture; click it to view, replace or remove it. */
function ImageInput({ c, run, style, id }: { c: FormControl; run: RunProps; style: CSSProperties; id?: string }) {
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const imageId = run.value ? String(run.value) : null;
  const url = imageId && run.imageUrl ? run.imageUrl(imageId) : null;
  const canEdit = !run.readOnly && !!run.uploadImage;
  const put = async (file: Blob) => run.onCommit(await run.uploadImage!(file));
  return (
    <>
      <button
        type="button"
        id={id}
        className={`fc-input fc-image ${over ? "drop-over" : ""}`}
        style={style}
        title={canEdit ? "Click to view or change the picture, or drop an image file here" : "Click to view the picture"}
        onClick={() => (url || canEdit) && setOpen(true)}
        onDragOver={(e) => {
          if (!canEdit) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = canEdit ? pictureIn(e.dataTransfer.files) : null;
          if (f) put(f).catch(() => setOpen(true));
        }}
      >
        {url ? <img src={url} alt={c.label ?? c.field ?? "Picture"} /> : <span className="fc-muted">{canEdit ? "Add a picture" : "No picture"}</span>}
      </button>
      {open && (
        <ImageDialog
          title={c.label ?? c.field ?? "Picture"}
          url={url}
          canEdit={canEdit}
          onPick={async (file) => {
            await put(file);
            setOpen(false);
          }}
          onRemove={() => {
            run.onCommit("");
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
