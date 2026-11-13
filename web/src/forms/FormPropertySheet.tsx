/** Property Sheet for Form Design View: the form's properties, or the selected controls'. */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BUTTON_ACTIONS,
  FORM_THEMES,
  NAME_PATTERN,
  type Field,
  type FormControl,
  type FormControlType,
  type FormDef,
  type FormLayout,
} from "../../../shared/model";
import { readSource, type ResultSet } from "../engine/engine";
import { compileExpression, isExpression, NAMED_FORMATS } from "../engine/expr";
import { ExpressionBuilder } from "./ExpressionBuilder";
import { makeFormCalc } from "./formCalc";
import { ComboBox } from "../ui/ComboBox";
import { useWorkspace } from "../workspace/context";
import { ACTION_LABELS, CONTROL_LABELS, hasLabel, isBound, THEMES } from "./formLayout";

type Patch = Partial<FormControl>;

const LIMITS: Partial<Record<keyof FormControl, [number, number]>> = {
  x: [0, 4000],
  y: [0, 4000],
  w: [1, 4000],
  h: [1, 4000],
  fontSize: [8, 72],
  borderWidth: [0, 12],
  radius: [0, 60],
  labelWidth: [20, 1000],
};

/** Columns of a table or query (queries are run to find them). */
function useColumnsOf(kind: string | undefined, id: string | undefined) {
  const ws = useWorkspace();
  const [cols, setCols] = useState<string[]>([]);
  const table = kind === "table" ? ws.doc.tables.find((t) => t.id === id) : undefined;
  const query = kind === "query" ? ws.doc.queries.find((q) => q.id === id) : undefined;
  useEffect(() => {
    if (table) return setCols(table.fields.map((f) => f.name));
    if (!query) return setCols([]);
    let cancelled = false;
    readSource(ws.doc, { kind: "query", id: query.id })
      .then((d) => !cancelled && setCols(d.columns))
      .catch(() => !cancelled && setCols([]));
    return () => {
      cancelled = true;
    };
  }, [table, query]); // eslint-disable-line react-hooks/exhaustive-deps
  return cols;
}

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="ps-row" title={hint}>
      <span className="ps-label">{label}</span>
      <div className="ps-value">{children}</div>
    </div>
  );
}

function TextProp(props: { value: string | undefined; onCommit: (v: string) => void; multiline?: boolean; placeholder?: string; label: string; validate?: (v: string) => string | null }) {
  const [err, setErr] = useState<string | null>(null);
  const commit = (el: HTMLInputElement | HTMLTextAreaElement) => {
    if (el.value === (props.value ?? "")) return setErr(null);
    const e = props.validate?.(el.value) ?? null;
    setErr(e);
    if (e) return;
    props.onCommit(el.value);
  };
  const common = {
    key: props.value ?? "",
    defaultValue: props.value ?? "",
    "aria-label": props.label,
    placeholder: props.placeholder,
    className: `ps-input ${err ? "has-error" : ""}`,
    onBlur: (e: { target: HTMLInputElement | HTMLTextAreaElement }) => commit(e.target),
  };
  return (
    <>
      {props.multiline ? (
        <textarea {...common} rows={4} />
      ) : (
        <input {...common} onKeyDown={(e) => e.key === "Enter" && commit(e.currentTarget)} />
      )}
      {err && <div className="ps-error">{err}</div>}
    </>
  );
}

function NumberProp(props: { value: number | undefined; min: number; max: number; onCommit: (v: number | undefined) => void; label: string; allowBlank?: boolean }) {
  const commit = (el: HTMLInputElement) => {
    const t = el.value.trim();
    if (!t) {
      if (props.allowBlank) props.onCommit(undefined);
      else el.value = String(props.value ?? "");
      return;
    }
    const n = Math.round(Number(t));
    if (!Number.isFinite(n)) {
      el.value = String(props.value ?? "");
      return;
    }
    const v = Math.max(props.min, Math.min(props.max, n));
    el.value = String(v);
    if (v !== props.value) props.onCommit(v);
  };
  return (
    <input
      key={String(props.value)}
      className="ps-input num"
      type="number"
      inputMode="numeric"
      aria-label={props.label}
      min={props.min}
      max={props.max}
      defaultValue={props.value ?? ""}
      onBlur={(e) => commit(e.target)}
      onKeyDown={(e) => e.key === "Enter" && commit(e.currentTarget)}
    />
  );
}

function BoolProp({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="ps-switch">
      <input type="checkbox" checked={value} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span>{value ? "Yes" : "No"}</span>
    </label>
  );
}

function ColorProp({ value, onChange, label }: { value: string | undefined; onChange: (v: string | undefined) => void; label: string }) {
  return (
    <span className="ps-color">
      <input type="color" aria-label={label} value={value ?? "#000000"} onChange={(e) => onChange(e.target.value)} className={value ? "" : "auto"} />
      <span className="ps-color-text">{value ?? "Automatic"}</span>
      {value && (
        <button className="icon-btn" title="Use the theme's colour" aria-label={`Reset ${label}`} onClick={() => onChange(undefined)}>
          ✕
        </button>
      )}
    </span>
  );
}

function Select<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return <ComboBox className="ps-input" value={value} options={options} onChange={onChange} ariaLabel={label} />;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="ps-group">
      <button className="ps-group-title" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="ps-chev">{open ? "▾" : "▸"}</span> {title}
      </button>
      {open && <div className="ps-group-body">{children}</div>}
    </section>
  );
}

export function FormPropertySheet(props: {
  form: FormDef;
  layout: FormLayout;
  selected: FormControl[];
  fields: { name: string; field?: Field }[];
  /** The form's records, for the Expression Builder's live result. */
  sample?: ResultSet;
  onPatch: (patch: Patch) => void;
  onForm: (fn: (f: FormDef, l: FormLayout) => void) => void;
  onClose?: () => void;
}) {
  const { form, layout, selected, fields, onPatch, onForm } = props;
  const ws = useWorkspace();
  const one = selected.length === 1 ? selected[0] : null;
  const types = new Set(selected.map((c) => c.type));
  const all = (pred: (t: FormControlType) => boolean) => selected.length > 0 && [...types].every(pred);
  /** The shared value of a property, or undefined when the selected controls differ. */
  const common = <K extends keyof FormControl>(k: K): FormControl[K] | undefined => {
    const v = selected[0]?.[k];
    return selected.every((c) => c[k] === v) ? v : undefined;
  };
  const num = (k: keyof FormControl, label: string, allowBlank = false) => (
    <Row label={label}>
      <NumberProp label={label} value={common(k) as number | undefined} min={LIMITS[k]![0]} max={LIMITS[k]![1]} allowBlank={allowBlank} onCommit={(v) => onPatch({ [k]: v } as Patch)} />
    </Row>
  );
  const bool = (k: keyof FormControl, label: string, invert = false) => {
    const v = !!common(k);
    return (
      <Row label={label}>
        <BoolProp label={label} value={invert ? !v : v} onChange={(b) => onPatch({ [k]: (invert ? !b : b) || undefined } as Patch)} />
      </Row>
    );
  };
  const color = (k: "color" | "backColor" | "borderColor", label: string) => (
    <Row label={label}>
      <ColorProp label={label} value={common(k)} onChange={(v) => onPatch({ [k]: v })} />
    </Row>
  );

  /** Binds the selected control to a field (or unbinds it), keeping its label in step. */
  const bindTo = (v: string) => {
    if (!one) return;
    const fd = fields.find((f) => f.name === v)?.field;
    const patch: Patch = { field: v || undefined };
    // Keep the label in step when it still shows the old field's name.
    const auto = (t?: string) => !t || t === one.field || t === one.name;
    if (hasLabel(one.type) && auto(one.label)) patch.label = v || one.name;
    if (one.type === "checkbox" && auto(one.caption)) patch.caption = v || one.name;
    if (fd?.type === "AutoNumber") patch.locked = true;
    if (!isExpression(v)) patch.format = undefined;
    onPatch(patch);
  };

  const header = (
    <div className="ps-head">
      <div>
        <div className="ps-kicker">Property Sheet</div>
        <div className="ps-title">
          {selected.length === 0 ? `Form: ${form.name}` : one ? `${CONTROL_LABELS[one.type]}: ${one.name}` : `${selected.length} controls selected`}
        </div>
      </div>
      {props.onClose && (
        <button className="icon-btn" aria-label="Close Property Sheet" onClick={props.onClose}>
          ✕
        </button>
      )}
    </div>
  );

  if (!selected.length) {
    const sources = [
      ...ws.doc.tables.map((t) => ({ value: `table:${t.id}`, label: `Table: ${t.name}` })),
      ...ws.doc.queries.map((q) => ({ value: `query:${q.id}`, label: `Query: ${q.name}` })),
    ];
    const sec = (k: "header" | "detail" | "footer", label: string) => (
      <Row label={label}>
        <NumberProp label={label} value={layout.sections[k]} min={k === "detail" ? 16 : 0} max={k === "detail" ? 4000 : 2000} onCommit={(v) => onForm((_, l) => (l.sections[k] = v ?? 0))} />
      </Row>
    );
    const flag = (k: "navigationButtons" | "allowEdits" | "allowAdditions" | "allowDeletions", label: string) => (
      <Row label={label}>
        <BoolProp label={label} value={layout[k] !== false} onChange={(b) => onForm((_, l) => (b ? delete l[k] : (l[k] = false)))} />
      </Row>
    );
    return (
      <div className="prop-sheet">
        {header}
        <Group title="Format">
          <Row label="Caption">
            <TextProp label="Caption" value={form.title} onCommit={(v) => onForm((f) => (f.title = v.slice(0, 200)))} />
          </Row>
          <Row label="Theme">
            <Select label="Theme" value={layout.theme} options={FORM_THEMES.map((t) => ({ value: t, label: THEMES[t].label }))} onChange={(t) => onForm((_, l) => (l.theme = t))} />
          </Row>
          <Row label="Width">
            <NumberProp label="Width" value={layout.width} min={160} max={4000} onCommit={(v) => onForm((_, l) => (l.width = v ?? l.width))} />
          </Row>
          {sec("header", "Header Height")}
          {sec("detail", "Detail Height")}
          {sec("footer", "Footer Height")}
          {flag("navigationButtons", "Navigation Buttons")}
        </Group>
        <Group title="Data">
          <Row label="Record Source">
            <Select
              label="Record Source"
              value={`${form.source.kind}:${form.source.id}`}
              options={sources}
              onChange={(v) => {
                const [k, id] = v.split(":");
                onForm((f) => (f.source = { kind: k as "table" | "query", id }));
              }}
            />
          </Row>
          {flag("allowEdits", "Allow Edits")}
          {flag("allowAdditions", "Allow Additions")}
          {flag("allowDeletions", "Allow Deletions")}
        </Group>
        <p className="ps-tip">Click a control to see its properties. Shift+click or drag around controls to select several.</p>
      </div>
    );
  }

  const fieldOptions = [{ value: "", label: "(unbound)" }, ...fields.map((f) => ({ value: f.name, label: f.name }))];
  const nameError = (v: string) => {
    const n = v.trim();
    if (!NAME_PATTERN.test(n)) return "Names can't be empty or contain . ! ` [ or ].";
    if (layout.controls.some((c) => c.id !== one!.id && c.name.toLowerCase() === n.toLowerCase())) return `There is already a control named '${n}'.`;
    return null;
  };

  return (
    <div className="prop-sheet">
      {header}
      {one && (
        <Group title="Other">
          <Row label="Name">
            <TextProp label="Name" value={one.name} validate={nameError} onCommit={(v) => onPatch({ name: v.trim() })} />
          </Row>
        </Group>
      )}
      {one && isBound(one.type) && (
        <Group title="Data">
          <Row label="Control Source">
            {one.type === "textbox" ? (
              <ControlSourceProp c={one} form={form} layout={layout} fields={fields} sample={props.sample} onBind={bindTo} onPatch={onPatch} />
            ) : (
              <Select
                label="Control Source"
                value={one.field ?? ""}
                options={one.field && !fields.some((f) => f.name === one.field) ? [...fieldOptions, { value: one.field, label: `${one.field} (not in source)` }] : fieldOptions}
                onChange={bindTo}
              />
            )}
          </Row>
          {one.type === "textbox" && isExpression(one.field) && (
            <Row label="Format" hint="How the calculated value is shown">
              <input
                key={one.format ?? ""}
                className="ps-input"
                aria-label="Format"
                list="ps-formats"
                placeholder="General"
                defaultValue={one.format ?? ""}
                onBlur={(e) => e.target.value.trim() !== (one.format ?? "") && onPatch({ format: e.target.value.trim().slice(0, 100) || undefined })}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
              <datalist id="ps-formats">
                {NAMED_FORMATS.map((f) => (
                  <option key={f} value={f} />
                ))}
                <option value="0.00" />
                <option value="#,##0" />
                <option value="mm/dd/yyyy" />
                <option value="mmmm d, yyyy" />
                <option value="hh:nn AM/PM" />
              </datalist>
            </Row>
          )}
          {(one.type === "combobox" || one.type === "listbox") && <RowSourceProps c={one} onPatch={onPatch} />}
          {bool("locked", "Locked")}
          {(one.type === "textbox" || one.type === "combobox") && (
            <Row label="Placeholder">
              <TextProp label="Placeholder" value={one.placeholder} onCommit={(v) => onPatch({ placeholder: v.slice(0, 200) || undefined })} />
            </Row>
          )}
        </Group>
      )}
      {one?.type === "button" && (
        <Group title="Event">
          <Row label="On Click">
            <Select
              label="On Click"
              value={one.action ?? "none"}
              options={BUTTON_ACTIONS.map((a) => ({ value: a, label: ACTION_LABELS[a] }))}
              onChange={(a) => onPatch({ action: a, target: a === "openForm" || a === "openReport" ? one.target : undefined })}
            />
          </Row>
          {(one.action === "openForm" || one.action === "openReport") && (
            <Row label={one.action === "openForm" ? "Form" : "Report"}>
              <Select
                label="Object to open"
                value={one.target ?? ""}
                options={[
                  { value: "", label: "(choose)" },
                  ...(one.action === "openForm" ? ws.doc.forms.filter((f) => f.id !== form.id) : ws.doc.reports).map((o) => ({ value: o.id, label: o.name })),
                ]}
                onChange={(v) => onPatch({ target: v || undefined })}
              />
            </Row>
          )}
        </Group>
      )}
      <Group title="Format">
        {one && (one.type === "label" || one.type === "button" || one.type === "checkbox") && (
          <Row label="Caption">
            <TextProp label="Caption" value={one.caption} multiline={one.type === "label"} onCommit={(v) => onPatch({ caption: v.slice(0, 500) })} />
          </Row>
        )}
        {one && hasLabel(one.type) && (
          <>
            <Row label="Label">
              <TextProp label="Label" value={one.label} onCommit={(v) => onPatch({ label: v.slice(0, 200) })} />
            </Row>
            <Row label="Label Position">
              <Select
                label="Label Position"
                value={one.labelPos ?? "top"}
                options={[
                  { value: "top", label: "Above" },
                  { value: "left", label: "Left" },
                  { value: "none", label: "None" },
                ]}
                onChange={(v) => onPatch({ labelPos: v === "top" ? undefined : v })}
              />
            </Row>
            {one.labelPos === "left" && num("labelWidth", "Label Width", true)}
          </>
        )}
        {one?.type === "textbox" && bool("multiline", "Multiple Lines")}
        {one?.type === "button" && (
          <Row label="Style">
            <Select
              label="Button style"
              value={(one.variant as "primary") ?? "primary"}
              options={[
                { value: "primary", label: "Filled" },
                { value: "secondary", label: "Soft" },
                { value: "outline", label: "Outline" },
                { value: "danger", label: "Warning (red)" },
              ]}
              onChange={(v) => onPatch({ variant: v })}
            />
          </Row>
        )}
        {one?.type === "checkbox" && (
          <Row label="Style">
            <Select
              label="Check box style"
              value={one.variant === "switch" ? "switch" : "check"}
              options={[
                { value: "check", label: "Check box" },
                { value: "switch", label: "Switch" },
              ]}
              onChange={(v) => onPatch({ variant: v === "switch" ? "switch" : undefined })}
            />
          </Row>
        )}
        {bool("hidden", "Visible", true)}
        {num("x", "Left")}
        {num("y", "Top")}
        {num("w", "Width")}
        {num("h", "Height")}
        {!all((t) => t === "rectangle" || t === "line") && (
          <>
            {num("fontSize", "Font Size", true)}
            {bool("bold", "Bold")}
            {bool("italic", "Italic")}
            <Row label="Text Align">
              <Select
                label="Text Align"
                value={common("align") ?? ""}
                options={[
                  { value: "", label: "General" },
                  { value: "left", label: "Left" },
                  { value: "center", label: "Center" },
                  { value: "right", label: "Right" },
                ]}
                onChange={(v) => onPatch({ align: (v || undefined) as FormControl["align"] })}
              />
            </Row>
            {color("color", "Fore Color")}
          </>
        )}
        {!all((t) => t === "line" || t === "checkbox") && color("backColor", "Back Color")}
        {color("borderColor", all((t) => t === "line") ? "Line Color" : "Border Color")}
        {!all((t) => t === "line" || t === "checkbox") && (
          <>
            {num("borderWidth", "Border Width", true)}
            {num("radius", "Corner Radius", true)}
          </>
        )}
      </Group>
    </div>
  );
}

function RowSourceProps({ c, onPatch }: { c: FormControl; onPatch: (p: Patch) => void }) {
  const ws = useWorkspace();
  const type = c.rowSourceType ?? "values";
  const cols = useColumnsOf(type, c.rowSource);
  const colOptions = [{ value: "", label: "(automatic)" }, ...cols.map((x) => ({ value: x, label: x }))];
  return (
    <>
      <Row label="Row Source Type">
        <Select
          label="Row Source Type"
          value={type}
          options={[
            { value: "values", label: "Value List" },
            { value: "table", label: "Table" },
            { value: "query", label: "Query" },
          ]}
          onChange={(v) => v !== type && onPatch({ rowSourceType: v, rowSource: "", boundColumn: undefined, displayColumn: undefined })}
        />
      </Row>
      {type === "values" ? (
        <Row label="Row Source" hint="One choice per line, or separated by semicolons">
          <TextProp label="Row Source" multiline value={(c.rowSource ?? "").split(";").join("\n")} placeholder={"One choice per line"} onCommit={(v) => onPatch({ rowSource: v.split("\n").map((s) => s.trim()).filter(Boolean).join(";").slice(0, 4000) })} />
        </Row>
      ) : (
        <>
          <Row label="Row Source">
            <Select
              label="Row Source"
              value={c.rowSource ?? ""}
              options={[{ value: "", label: "(choose)" }, ...(type === "table" ? ws.doc.tables : ws.doc.queries).map((o) => ({ value: o.id, label: o.name }))]}
              onChange={(v) => onPatch({ rowSource: v, boundColumn: undefined, displayColumn: undefined })}
            />
          </Row>
          <Row label="Bound Column" hint="The value saved in the field">
            <Select label="Bound Column" value={c.boundColumn ?? ""} options={colOptions} onChange={(v) => onPatch({ boundColumn: v || undefined })} />
          </Row>
          <Row label="Display Column" hint="What people see in the list">
            <Select label="Display Column" value={c.displayColumn ?? ""} options={colOptions} onChange={(v) => onPatch({ displayColumn: v || undefined })} />
          </Row>
        </>
      )}
    </>
  );
}

/**
 * A text box's Control Source: type a field name or an expression starting with =, pick a field
 * from the list, or click … for the Expression Builder.
 */
function ControlSourceProp(props: {
  c: FormControl;
  form: FormDef;
  layout: FormLayout;
  fields: { name: string; field?: Field }[];
  sample?: ResultSet;
  onBind: (field: string) => void;
  onPatch: (p: Patch) => void;
}) {
  const { c, fields } = props;
  const ws = useWorkspace();
  const [err, setErr] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const listId = `ps-src-${c.id}`;

  const apply = (raw: string): string | null => {
    const v = raw.trim();
    if (v === (c.field ?? "")) return null;
    if (!v) {
      props.onBind("");
      return null;
    }
    if (isExpression(v)) {
      const r = compileExpression(v);
      if (!r.ok) return r.error;
      props.onPatch({ field: "=" + v.replace(/^\s*=\s*/, "") });
      return null;
    }
    const f = fields.find((x) => x.name.toLowerCase() === v.replace(/^\[|\]$/g, "").toLowerCase());
    if (!f && fields.length) return `There's no field named ${v}. To calculate a value, start with = (or click … for the Expression Builder).`;
    props.onBind(f?.name ?? v);
    return null;
  };
  const commit = (el: HTMLInputElement) => {
    const e = apply(el.value);
    setErr(e);
  };

  const preview = useMemo(() => {
    const data = props.sample;
    if (!data) return undefined;
    const calc = makeFormCalc(ws.doc, props.layout, data.columns);
    return (expr: string) => calc.preview(expr, data.rows[0] ?? null, () => data.rows, c.format);
  }, [props.sample, props.layout, ws.doc, c.format]);

  return (
    <>
      <div className="ps-source">
        <input
          key={c.field ?? ""}
          className={`ps-input ${err ? "has-error" : ""} ${isExpression(c.field) ? "expr" : ""}`}
          aria-label="Control Source"
          list={listId}
          placeholder="Unbound"
          defaultValue={c.field ?? ""}
          title={c.field}
          onBlur={(e) => commit(e.target)}
          onKeyDown={(e) => e.key === "Enter" && commit(e.currentTarget)}
        />
        <datalist id={listId}>
          {fields.map((f) => (
            <option key={f.name} value={f.name} />
          ))}
        </datalist>
        <button className="ps-build" title="Build an expression (Expression Builder)" aria-label="Open the Expression Builder" onClick={() => setBuilding(true)}>
          …
        </button>
      </div>
      {err && <div className="ps-error">{err}</div>}
      {building && (
        <ExpressionBuilder
          initial={isExpression(c.field) ? (c.field ?? "").replace(/^\s*=\s*/, "") : c.field ? `[${c.field}]` : ""}
          formName={props.form.name}
          fields={fields}
          controls={props.layout.controls.filter((x) => x.id !== c.id && x.type !== "label" && x.type !== "line" && x.type !== "rectangle" && x.type !== "button").map((x) => ({ name: x.name, source: x.field, type: x.type }))}
          doc={ws.doc}
          preview={preview}
          previewLabel={props.sample?.rows.length ? "Result for the first record" : "Result (there are no records yet)"}
          onClose={() => setBuilding(false)}
          onOk={(expr) => {
            setBuilding(false);
            setErr(null);
            const just = /^\[([^\]]+)\]$/.exec(expr.trim());
            const f = just && fields.find((x) => x.name.toLowerCase() === just[1].toLowerCase());
            if (!expr.trim()) props.onBind("");
            else if (f) props.onBind(f.name);
            else props.onPatch({ field: "=" + expr.trim() });
          }}
        />
      )}
    </>
  );
}
