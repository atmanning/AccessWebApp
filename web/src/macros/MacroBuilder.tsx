/**
 * The Macro Builder: a macro's steps as blocks, as in Access 2010 and later. Each action shows
 * its arguments; If blocks hold their own steps, with Else If / Else; comments, groups and
 * submacros too. Used for a control's or form's event (a dialog) and for named macros (a tab).
 */
import { useMemo, useState, type ReactNode } from "react";
import { MACRO_ACTIONS, macroActions, type MacroArgDef, type MacroStep } from "../../../shared/macros";
import type { MacroDef } from "../../../shared/macros";
import { Modal } from "../ui/dialogs";
import { useWorkspace } from "../workspace/context";
import { useMacroRunner } from "./useMacroRunner";
import "./macros.css";

const GROUP_ORDER = ["Window", "Records", "Filter/Query/Search", "Data", "User Interface", "Macro Commands", "System"] as const;

/** Names offered for object and control arguments. */
export interface MacroNames {
  controls?: string[];
}

function ActionPicker(props: { value?: string; onPick: (a: string) => void; allowBlocks: { submacro?: boolean }; placeholder?: string }) {
  const byGroup = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [name, def] of Object.entries(MACRO_ACTIONS)) m.set(def.group, [...(m.get(def.group) ?? []), name]);
    return m;
  }, []);
  const known = !props.value || props.value in MACRO_ACTIONS;
  return (
    <select
      className="mb-picker"
      aria-label={props.placeholder ?? "Action"}
      value={props.value ?? ""}
      onChange={(e) => e.target.value && props.onPick(e.target.value)}
    >
      {!props.value && <option value="">{props.placeholder ?? "Add New Action"}</option>}
      {!known && <option value={props.value}>{props.value} (not supported here)</option>}
      {!props.value && (
        <optgroup label="Program Flow">
          <option value="#comment">Comment</option>
          <option value="#group">Group</option>
          <option value="#if">If</option>
          {props.allowBlocks.submacro && <option value="#submacro">Submacro</option>}
        </optgroup>
      )}
      {GROUP_ORDER.map((g) => (
        <optgroup key={g} label={g}>
          {(byGroup.get(g) ?? []).sort().map((a) => (
            <option key={a} value={a} title={MACRO_ACTIONS[a].help}>
              {a}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function newStep(choice: string): MacroStep {
  switch (choice) {
    case "#comment":
      return { kind: "comment", text: "" };
    case "#group":
      return { kind: "group", name: "Group1", steps: [] };
    case "#if":
      return { kind: "if", branches: [{ condition: "", steps: [] }] };
    case "#submacro":
      return { kind: "submacro", name: "Submacro1", steps: [] };
  }
  return { kind: "action", action: choice, args: {} };
}

function ArgInput(props: { def: MacroArgDef; value: string; onChange: (v: string) => void; names: Record<string, string[]>; id: string }) {
  const { def, value, onChange } = props;
  if (def.kind === "choice") {
    const choices = def.choices ?? [];
    return (
      <select id={props.id} className="mb-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {!choices.includes("") && <option value="">{def.default ? `(${def.default})` : ""}</option>}
        {!choices.includes(value) && value !== "" && <option value={value}>{value}</option>}
        {choices.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    );
  }
  if (def.kind === "sql") {
    return <textarea id={props.id} className="mb-input mono" rows={3} value={value} spellCheck={false} onChange={(e) => onChange(e.target.value)} placeholder="UPDATE Orders SET Shipped = True WHERE OrderID = [Forms]![Orders]![OrderID]" />;
  }
  const list = props.names[def.kind];
  const listId = list?.length ? `${props.id}-list` : undefined;
  return (
    <>
      <input
        id={props.id}
        className={`mb-input ${def.kind === "expr" || def.kind === "where" ? "mono" : ""}`}
        value={value}
        list={listId}
        spellCheck={false}
        placeholder={def.hint ?? (def.kind === "expr" ? "an expression, e.g. [Quantity] * 2" : def.default ? `(${def.default})` : "")}
        onChange={(e) => onChange(e.target.value)}
      />
      {listId && (
        <datalist id={listId}>
          {list!.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      )}
    </>
  );
}

let uid = 0;

function StepList(props: { steps: MacroStep[]; onChange: (s: MacroStep[]) => void; names: Record<string, string[]>; topLevel?: boolean }) {
  const { steps, onChange } = props;
  const set = (i: number, s: MacroStep) => onChange(steps.map((x, j) => (j === i ? s : x)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const remove = (i: number) => onChange(steps.filter((_, j) => j !== i));
  return (
    <div className="mb-list">
      {steps.map((s, i) => (
        <StepBlock key={i} step={s} onChange={(x) => set(i, x)} names={props.names} tools={<BlockTools onUp={i > 0 ? () => move(i, -1) : undefined} onDown={i < steps.length - 1 ? () => move(i, 1) : undefined} onRemove={() => remove(i)} />} />
      ))}
      <div className="mb-add">
        <span className="mb-plus">+</span>
        <ActionPicker key={steps.length} onPick={(a) => onChange([...steps, newStep(a)])} allowBlocks={{ submacro: props.topLevel }} />
      </div>
    </div>
  );
}

function BlockTools(props: { onUp?: () => void; onDown?: () => void; onRemove: () => void }) {
  return (
    <span className="mb-tools">
      <button className="icon-btn" title="Move up" aria-label="Move up" disabled={!props.onUp} onClick={props.onUp}>
        ▲
      </button>
      <button className="icon-btn" title="Move down" aria-label="Move down" disabled={!props.onDown} onClick={props.onDown}>
        ▼
      </button>
      <button className="icon-btn" title="Delete" aria-label="Delete" onClick={props.onRemove}>
        ✕
      </button>
    </span>
  );
}

function StepBlock(props: { step: MacroStep; onChange: (s: MacroStep) => void; names: Record<string, string[]>; tools: ReactNode }) {
  const { step: s, onChange } = props;
  const [id] = useState(() => `mb${++uid}`);
  switch (s.kind) {
    case "comment":
      return (
        <div className="mb-block mb-comment">
          <div className="mb-head">
            <span className="mb-kw">/*</span>
            <textarea className="mb-input" rows={1} aria-label="Comment" value={s.text} onChange={(e) => onChange({ ...s, text: e.target.value })} placeholder="A note about what this macro does" />
            <span className="mb-kw">*/</span>
            {props.tools}
          </div>
        </div>
      );
    case "group":
    case "submacro":
      return (
        <div className={`mb-block mb-${s.kind}`}>
          <div className="mb-head">
            <span className="mb-kw">{s.kind === "group" ? "Group:" : "Submacro:"}</span>
            <input className="mb-input" aria-label={`${s.kind} name`} value={s.name} onChange={(e) => onChange({ ...s, name: e.target.value })} />
            {props.tools}
          </div>
          <div className="mb-body">
            <StepList steps={s.steps} onChange={(steps) => onChange({ ...s, steps })} names={props.names} />
          </div>
          <div className="mb-kw mb-end">End {s.kind === "group" ? "Group" : "Submacro"}</div>
        </div>
      );
    case "if": {
      const setBranch = (i: number, b: (typeof s.branches)[number]) => onChange({ ...s, branches: s.branches.map((x, j) => (j === i ? b : x)) });
      const hasElse = s.branches.some((b) => b.condition === undefined);
      return (
        <div className="mb-block mb-if">
          {s.branches.map((b, i) => (
            <div key={i} className="mb-branch">
              <div className="mb-head">
                <span className="mb-kw">{i === 0 ? "If" : b.condition === undefined ? "Else" : "Else If"}</span>
                {b.condition !== undefined && (
                  <>
                    <input
                      className="mb-input mono"
                      aria-label="Condition"
                      value={b.condition}
                      spellCheck={false}
                      placeholder="e.g. IsNull([CustomerID]) or [Balance] > 0"
                      onChange={(e) => setBranch(i, { ...b, condition: e.target.value })}
                    />
                    <span className="mb-kw">Then</span>
                  </>
                )}
                {i === 0 ? (
                  props.tools
                ) : (
                  <button className="icon-btn" title="Remove this branch" aria-label="Remove branch" onClick={() => onChange({ ...s, branches: s.branches.filter((_, j) => j !== i) })}>
                    ✕
                  </button>
                )}
              </div>
              <div className="mb-body">
                <StepList steps={b.steps} onChange={(steps) => setBranch(i, { ...b, steps })} names={props.names} />
              </div>
            </div>
          ))}
          <div className="mb-if-foot">
            <button className="link-btn" onClick={() => onChange({ ...s, branches: hasElse ? [...s.branches.slice(0, -1), { condition: "", steps: [] }, s.branches[s.branches.length - 1]] : [...s.branches, { condition: "", steps: [] }] })}>
              Add Else If
            </button>
            {!hasElse && (
              <button className="link-btn" onClick={() => onChange({ ...s, branches: [...s.branches, { steps: [] }] })}>
                Add Else
              </button>
            )}
            <span className="mb-kw">End If</span>
          </div>
        </div>
      );
    }
    case "action": {
      const def = MACRO_ACTIONS[s.action];
      const args = s.args ?? {};
      const extra = Object.keys(args).filter((k) => !def?.args.some((a) => a.name === k));
      return (
        <div className={`mb-block mb-action ${def ? "" : "unknown"}`}>
          <div className="mb-head">
            <ActionPicker value={s.action} onPick={(a) => onChange({ kind: "action", action: a, args: {} })} allowBlocks={{}} />
            {def && <span className="mb-help">{def.help}</span>}
            {props.tools}
          </div>
          {(def?.args.length || extra.length) ? (
            <div className="mb-args">
              {def?.args.map((a) => (
                <label key={a.name} className="mb-arg" htmlFor={`${id}-${a.name}`}>
                  <span className="mb-arg-label">
                    {a.label}
                    {a.required && <span className="mb-req">*</span>}
                  </span>
                  <ArgInput
                    id={`${id}-${a.name}`}
                    def={a}
                    value={args[a.name] ?? ""}
                    names={props.names}
                    onChange={(v) => {
                      const next = { ...args, [a.name]: v };
                      if (v === "") delete next[a.name];
                      onChange({ ...s, args: next });
                    }}
                  />
                </label>
              ))}
              {extra.map((k) => (
                <label key={k} className="mb-arg">
                  <span className="mb-arg-label">{k}</span>
                  <input className="mb-input" value={args[k]} onChange={(e) => onChange({ ...s, args: { ...args, [k]: e.target.value } })} />
                </label>
              ))}
            </div>
          ) : null}
          {!def && <p className="mb-warn">This action came from Access and doesn't run here; it's kept so nothing is lost.</p>}
        </div>
      );
    }
  }
}

/** The Macro Builder for a list of steps. */
export function MacroEditor(props: { steps: MacroStep[]; onChange: (s: MacroStep[]) => void; names?: MacroNames; topLevel?: boolean }) {
  const ws = useWorkspace();
  const names = useMemo(
    () => ({
      form: ws.doc.forms.map((f) => f.name),
      report: ws.doc.reports.map((r) => r.name),
      table: ws.doc.tables.map((t) => t.name),
      query: ws.doc.queries.map((q) => q.name),
      macro: (ws.doc.macros ?? []).flatMap((m) => [m.name, ...m.steps.filter((s) => s.kind === "submacro").map((s) => `${m.name}.${(s as { name: string }).name}`)]),
      object: [...ws.doc.forms, ...ws.doc.reports, ...ws.doc.tables, ...ws.doc.queries].map((o) => o.name),
      control: props.names?.controls ?? [],
    }),
    [ws.doc, props.names],
  );
  return (
    <div className="mb">
      <StepList steps={props.steps} onChange={props.onChange} names={names} topLevel={props.topLevel} />
    </div>
  );
}

/** Problems worth fixing before saving: required arguments left blank. */
export function macroProblems(steps: MacroStep[]): string[] {
  const out: string[] = [];
  for (const s of macroActions(steps)) {
    const def = MACRO_ACTIONS[s.action];
    for (const a of def?.args ?? []) if (a.required && !s.args?.[a.name]?.trim()) out.push(`${s.action} needs ${a.label}.`);
  }
  return [...new Set(out)];
}

/** An event's embedded macro, edited in a dialog (Property Sheet → On Click → …). */
export function MacroBuilderDialog(props: { title: string; steps: MacroStep[]; names?: MacroNames; onSave: (s: MacroStep[]) => void; onClose: () => void }) {
  const [steps, setSteps] = useState<MacroStep[]>(() => structuredClone(props.steps));
  const problems = macroProblems(steps);
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      width={720}
      footer={
        <>
          {problems.length > 0 && <span className="mb-problems">{problems[0]}</span>}
          <button
            className="primary"
            onClick={() => {
              props.onSave(steps);
              props.onClose();
            }}
          >
            Save
          </button>
          <button onClick={props.onClose}>Cancel</button>
        </>
      }
    >
      <div className="mb-dialog">
        <MacroEditor steps={steps} onChange={setSteps} names={props.names} />
      </div>
    </Modal>
  );
}

/** A named macro's tab: the Macro Builder, with Save and Run. */
export function MacroDesignView({ macro }: { macro: MacroDef; tabKey: string }) {
  const ws = useWorkspace();
  const run = useMacroRunner();
  const [steps, setSteps] = useState<MacroStep[]>(() => structuredClone(macro.steps));
  const [saved, setSaved] = useState(macro.steps);
  const dirty = JSON.stringify(steps) !== JSON.stringify(saved);
  const problems = macroProblems(steps);
  const save = () => {
    ws.update((d) => {
      const m = d.macros?.find((x) => x.id === macro.id);
      if (m) m.steps = structuredClone(steps);
    });
    setSaved(steps);
    ws.setStatus(`Saved the macro '${macro.name}'.`);
  };
  return (
    <div className="mb-view">
      <div className="labels-toolbar">
        <strong>Macro: {macro.name}</strong>
        {macro.name.toLowerCase() === "autoexec" && <span className="muted">Runs when the database opens.</span>}
        <span className="spacer" />
        {problems.length > 0 && <span className="mb-problems">{problems[0]}</span>}
        <button onClick={save} disabled={!dirty || ws.readOnly}>
          {dirty ? "Save" : "Saved"}
        </button>
        <button className="primary" onClick={() => void run(steps)} disabled={!steps.length}>
          ▶ Run
        </button>
      </div>
      <div className="mb-view-body">
        <MacroEditor steps={steps} onChange={setSteps} topLevel />
      </div>
    </div>
  );
}
