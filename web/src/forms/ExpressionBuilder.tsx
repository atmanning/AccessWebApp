/**
 * Expression Builder, like Access's: an expression box, and three lists below it (Expression
 * Elements, Categories, Values) to pick fields, controls, functions, constants and operators from.
 * Double-click (or Insert) puts the choice at the cursor; functions come with «placeholders»
 * to replace. A live result for the first record shows whether it works before you click OK.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Field, FieldType, ProjectDoc } from "../../../shared/model";
import { compileExpression, FUNCTION_LIST, namesUsed, type FnCategory } from "../engine/expr";
import { Modal } from "../ui/dialogs";
import type { CalcResult } from "./formCalc";

type Item = { label: string; insert: string; help: string; syntax?: string };
type Element = "form" | "functions" | "tables" | "constants" | "operators" | "common";

const TYPE_NAMES: Record<FieldType, string> = {
  ShortText: "Short Text",
  LongText: "Long Text",
  Number: "Number",
  Currency: "Currency",
  DateTime: "Date/Time",
  YesNo: "Yes/No",
  AutoNumber: "AutoNumber",
  Image: "Picture",
};

const FN_CATEGORIES: FnCategory[] = ["Text", "Date/Time", "Math", "Conversion", "Program Flow", "Inspection", "SQL Aggregate", "Domain Aggregate"];

const OPERATORS: Record<string, Item[]> = {
  Arithmetic: [
    { label: "+", insert: " + ", help: "Adds two numbers (or a number of days to a date)." },
    { label: "-", insert: " - ", help: "Subtracts. Two dates give the days between them." },
    { label: "*", insert: " * ", help: "Multiplies." },
    { label: "/", insert: " / ", help: "Divides." },
    { label: "\\", insert: " \\ ", help: "Divides and drops the remainder (7 \\ 2 is 3)." },
    { label: "^", insert: "^", help: "Raises to a power (2^3 is 8)." },
    { label: "Mod", insert: " Mod ", help: "The remainder after dividing (7 Mod 2 is 1)." },
  ],
  Comparison: [
    { label: "=", insert: " = ", help: "True when both sides are equal (text ignores capitals)." },
    { label: "<>", insert: " <> ", help: "True when the sides differ." },
    { label: "<", insert: " < ", help: "Less than." },
    { label: ">", insert: " > ", help: "Greater than." },
    { label: "<=", insert: " <= ", help: "Less than or equal to." },
    { label: ">=", insert: " >= ", help: "Greater than or equal to." },
    { label: "Between", insert: " Between «value1» And «value2»", help: "True when the value is in a range, ends included." },
    { label: "Like", insert: ' Like "«pattern»"', help: 'Matches a pattern: * any characters, ? one character, # one digit. [Name] Like "S*"' },
    { label: "In", insert: " In («value1», «value2»)", help: "True when the value is one of a list." },
    { label: "Is Null", insert: " Is Null", help: "True when the value is blank." },
    { label: "Is Not Null", insert: " Is Not Null", help: "True when the value isn't blank." },
  ],
  Logical: [
    { label: "And", insert: " And ", help: "True when both sides are true." },
    { label: "Or", insert: " Or ", help: "True when either side is true." },
    { label: "Not", insert: "Not ", help: "The opposite: Not True is False." },
    { label: "Xor", insert: " Xor ", help: "True when exactly one side is true." },
  ],
  String: [{ label: "&", insert: " & ", help: 'Joins text: [FirstName] & " " & [LastName]. Blank values count as empty text.' }],
};

const CONSTANTS: Item[] = [
  { label: '"" (Empty String)', insert: '""', help: "Text with nothing in it." },
  { label: "True", insert: "True", help: "Yes / on / true." },
  { label: "False", insert: "False", help: "No / off / false." },
  { label: "Null", insert: "Null", help: "No value (blank)." },
];

/** Where a placeholder is: the first «…» at or after `from`. */
function placeholderAt(text: string, from: number): [number, number] | null {
  const a = text.indexOf("«", from);
  if (a < 0) return null;
  const b = text.indexOf("»", a);
  return b < 0 ? null : [a, b + 1];
}

export function ExpressionBuilder(props: {
  /** The expression without its leading = */
  initial: string;
  formName: string;
  fields: { name: string; field?: Field }[];
  controls: { name: string; source?: string; type: string }[];
  doc: ProjectDoc;
  /** Works out an expression for the first record, for the live result. */
  preview?: (expression: string) => CalcResult | null;
  previewLabel?: string;
  onOk: (expression: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(props.initial);
  const [element, setElement] = useState<Element>("form");
  const [category, setCategory] = useState("<Field List>");
  const [selected, setSelected] = useState<Item | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<{ msg: string; at?: number } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const t = box.current;
    if (!t) return;
    t.focus();
    const ph = placeholderAt(t.value, 0);
    if (ph) t.setSelectionRange(ph[0], ph[1]);
    else t.setSelectionRange(t.value.length, t.value.length);
  }, []);

  const tables = props.doc.tables;

  const categories: string[] = useMemo(() => {
    switch (element) {
      case "form":
        return ["<Field List>", "<Controls>"];
      case "functions":
        return ["<All>", ...FN_CATEGORIES];
      case "tables":
        return tables.map((t) => t.name);
      case "operators":
        return ["<All>", ...Object.keys(OPERATORS)];
      default:
        return ["<All>"];
    }
  }, [element, tables]);

  const fieldNames = props.fields.map((f) => f.name);
  const pick = (want: RegExp, fallback: string) => fieldNames.find((n) => want.test(n)) ?? fallback;
  const ref = (n: string) => (n.startsWith("«") ? n : `[${n}]`);

  const values: Item[] = useMemo(() => {
    switch (element) {
      case "form":
        return category === "<Controls>"
          ? props.controls.map((c) => ({
              label: c.name,
              insert: `[${c.name}]`,
              help: c.source ? `Control ${c.name}: ${c.source.startsWith("=") ? `calculates ${c.source}` : `shows the field ${c.source}`}.` : `Control ${c.name} (unbound).`,
            }))
          : props.fields.map((f) => ({ label: f.name, insert: `[${f.name}]`, help: `Field ${f.name}${f.field ? ` (${TYPE_NAMES[f.field.type]})` : ""}${f.field?.description ? `: ${f.field.description}` : "."}` }));
      case "functions":
        return FUNCTION_LIST.filter((f) => category === "<All>" || f.cat === category).map((f) => ({ label: f.name, insert: f.syntax, help: f.desc, syntax: f.syntax }));
      case "tables": {
        const t = tables.find((x) => x.name === category);
        return (t?.fields ?? []).map((f) => ({
          label: f.name,
          insert: `DLookup("[${f.name}]", "${t!.name}", "«criteria»")`,
          syntax: `DLookup("[${f.name}]", "${t!.name}", "«criteria»")`,
          help: `${f.name} from the ${t!.name} table (${TYPE_NAMES[f.type]}). Replace «criteria» with which record, e.g. "CustomerID=" & [CustomerID].`,
        }));
      }
      case "constants":
        return CONSTANTS;
      case "operators":
        return category === "<All>" ? Object.values(OPERATORS).flat() : OPERATORS[category] ?? [];
      case "common": {
        const first = pick(/^first.?name$/i, "«FirstName»");
        const last = pick(/^last.?name$/i, "«LastName»");
        const birth = pick(/birth|dob/i, "«BirthDate»");
        const qty = pick(/^(qty|quantity)$/i, "«Quantity»");
        const price = pick(/price|rate/i, "«UnitPrice»");
        const datef = props.fields.find((f) => f.field?.type === "DateTime")?.name ?? "«date»";
        return [
          { label: "Full Name", insert: `${ref(first)} & " " & ${ref(last)}`, help: "First and last name with a space between." },
          { label: "Name, Last First", insert: `${ref(last)} & ", " & ${ref(first)}`, help: "Last name, a comma, then first name." },
          { label: "Initials", insert: `Left(${ref(first)}, 1) & Left(${ref(last)}, 1)`, help: "The first letter of each name." },
          { label: "Age in Years", insert: `DateDiff("yyyy", ${ref(birth)}, Date()) - IIf(Format(${ref(birth)}, "mmdd") > Format(Date(), "mmdd"), 1, 0)`, help: "Whole years since a birth date, counting this year's birthday only once it's come." },
          { label: "Days Since", insert: `DateDiff("d", ${ref(datef)}, Date())`, help: "Days from a date until today." },
          { label: "Line Total", insert: `${ref(qty)} * ${ref(price)}`, help: "Quantity times price. Set Format to Currency." },
          { label: "Total of a Field", insert: `Sum(${fieldNames.length ? `[${fieldNames.find((n) => /total|amount|price|qty|quantity/i.test(n)) ?? "«field»"}]` : "«field»"})`, help: "The total over all records shown in the form. Put it in the form footer." },
          { label: "Record Count", insert: "Count(*)", help: "How many records the form shows." },
          { label: "Current Date", insert: "Date()", help: "Today's date." },
          { label: "Current Date/Time", insert: "Now()", help: "Today's date and the time now." },
          { label: "Blank Instead of Null", insert: `Nz(«value», "«if blank»")`, help: "Shows something else when a value is blank." },
          { label: "Yes / No Text", insert: `IIf(«condition», "Yes", "No")`, help: "Words for a true/false test." },
        ].map((x) => ({ ...x, insert: x.insert.replace(/\[«/g, "«").replace(/»\]/g, "»") }));
      }
    }
  }, [element, category, props.fields, props.controls, tables]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = filter.trim()
    ? (element === "functions" ? FUNCTION_LIST.map((f) => ({ label: f.name, insert: f.syntax, help: f.desc, syntax: f.syntax })) : values).filter((v) =>
        (v.label + " " + v.help).toLowerCase().includes(filter.trim().toLowerCase()),
      )
    : values;

  const insert = (item: Item) => {
    const t = box.current!;
    const start = t.selectionStart;
    const end = t.selectionEnd;
    let ins = item.insert;
    // Don't double up spaces around operators.
    if (ins.startsWith(" ") && /\s$/.test(text.slice(0, start))) ins = ins.trimStart();
    if (ins.endsWith(" ") && /^\s/.test(text.slice(end))) ins = ins.trimEnd();
    const next = text.slice(0, start) + ins + text.slice(end);
    setText(next);
    setError(null);
    requestAnimationFrame(() => {
      t.focus();
      const ph = placeholderAt(next, start);
      if (ph && ph[0] < start + ins.length) t.setSelectionRange(ph[0], ph[1]);
      else t.setSelectionRange(start + ins.length, start + ins.length);
    });
  };

  /** Clicking into a «placeholder» selects all of it, ready to type over. */
  const selectPlaceholder = () => {
    const t = box.current!;
    const pos = t.selectionStart;
    if (t.selectionEnd !== pos) return;
    const a = text.lastIndexOf("«", pos - 1);
    if (a < 0) return;
    const b = text.indexOf("»", a);
    if (b >= pos - 1 && text.lastIndexOf("»", pos - 1) < a) t.setSelectionRange(a, b + 1);
  };

  const check = (): string | null => {
    const src = text.trim();
    if (!src) return null;
    const c = compileExpression(src);
    if (!c.ok) {
      setError({ msg: c.error, at: c.at });
      return null;
    }
    if (props.fields.length) {
      const known = new Set([...fieldNames, ...props.controls.map((x) => x.name)].map((n) => n.toLowerCase()));
      const unknown = namesUsed(c.node).filter((n) => !known.has(n.toLowerCase()));
      if (unknown.length) {
        setError({ msg: `There's no field or control named ${unknown.map((n) => `[${n}]`).join(", ")} on this form. Check the spelling, or pick it from the list below.` });
        return null;
      }
    }
    return src;
  };

  const ok = () => {
    if (!text.trim()) return props.onOk("");
    const src = check();
    if (src !== null) props.onOk(src);
  };

  // Show where a syntax error is.
  useEffect(() => {
    if (error?.at !== undefined && box.current) {
      box.current.focus();
      box.current.setSelectionRange(error.at, Math.min(text.length, error.at + 1));
    }
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps

  const live = useMemo(() => {
    if (!text.trim() || !props.preview) return null;
    const c = compileExpression(text);
    if (!c.ok) return { text: "", value: null, error: c.error } as CalcResult;
    return props.preview(text);
  }, [text, props.preview]); // eslint-disable-line react-hooks/exhaustive-deps

  const elements: { id: Element; label: string; icon: string }[] = [
    { id: "form", label: props.formName, icon: "📄" },
    { id: "functions", label: "Functions", icon: "ƒ" },
    { id: "tables", label: "Tables (look up)", icon: "▦" },
    { id: "constants", label: "Constants", icon: "≡" },
    { id: "operators", label: "Operators", icon: "±" },
    { id: "common", label: "Common Expressions", icon: "★" },
  ];

  return (
    <Modal
      title="Expression Builder"
      onClose={props.onClose}
      width={820}
      footer={
        <>
          <span className="eb-keys small muted">Double-click an item to insert it · Ctrl+Enter for OK</span>
          <span className="spacer" />
          <button className="primary" onClick={ok}>
            OK
          </button>
          <button onClick={props.onClose}>Cancel</button>
        </>
      }
    >
      <div className="eb">
        <label className="eb-prompt" htmlFor="eb-text">
          Enter an expression to calculate the control's value: <span className="muted">(for example [Price] * [Quantity], or [FirstName] &amp; " " &amp; [LastName])</span>
        </label>
        <div className="eb-text-row">
          <span className="eb-equals" aria-hidden="true">=</span>
          <textarea
            id="eb-text"
            ref={box}
            className={`eb-text ${error ? "has-error" : ""}`}
            value={text}
            spellCheck={false}
            aria-label="Expression"
            aria-invalid={!!error}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            onClick={selectPlaceholder}
            onDoubleClick={selectPlaceholder}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                ok();
              } else if (e.key === "Enter") {
                // One line, like Access; Enter means OK.
                e.preventDefault();
                ok();
              } else if (e.key === "Tab" && !e.shiftKey) {
                // Tab jumps to the next «placeholder», if there is one.
                const t = e.currentTarget;
                const ph = placeholderAt(text, t.selectionEnd) ?? placeholderAt(text, 0);
                if (ph) {
                  e.preventDefault();
                  t.setSelectionRange(ph[0], ph[1]);
                }
              }
            }}
          />
        </div>
        <div className={`eb-result ${error || live?.error ? "bad" : ""}`} role="status">
          {error ? (
            <>⚠ {error.msg}</>
          ) : !text.trim() ? (
            <span className="muted">Leave the box empty to make the control unbound.</span>
          ) : live?.error ? (
            <>⚠ {live.error}</>
          ) : live ? (
            <>
              <span className="muted">{props.previewLabel ?? "Result for the first record"}:</span> <strong>{live.text === "" ? <em className="muted">(blank)</em> : live.text}</strong>
            </>
          ) : null}
        </div>

        <div className="eb-panes">
          <div className="eb-pane">
            <div className="eb-pane-title">Expression Elements</div>
            <div className="eb-list" role="listbox" aria-label="Expression Elements">
              {elements.map((el) => (
                <div
                  key={el.id}
                  role="option"
                  aria-selected={element === el.id}
                  className={`eb-item ${element === el.id ? "sel" : ""}`}
                  onClick={() => {
                    setElement(el.id);
                    setCategory(el.id === "form" ? "<Field List>" : el.id === "tables" ? tables[0]?.name ?? "" : "<All>");
                    setSelected(null);
                  }}
                >
                  <span className="eb-icon" aria-hidden="true">{el.icon}</span>
                  {el.label}
                </div>
              ))}
            </div>
          </div>
          <div className="eb-pane">
            <div className="eb-pane-title">Expression Categories</div>
            <div className="eb-list" role="listbox" aria-label="Expression Categories">
              {categories.map((c) => (
                <div
                  key={c}
                  role="option"
                  aria-selected={category === c}
                  className={`eb-item ${category === c ? "sel" : ""}`}
                  onClick={() => {
                    setCategory(c);
                    setSelected(null);
                  }}
                >
                  {c}
                </div>
              ))}
              {!categories.length && <div className="eb-item muted">(no tables)</div>}
            </div>
          </div>
          <div className="eb-pane wide">
            <div className="eb-pane-title">
              Expression Values
              <input className="eb-filter" placeholder="Search…" aria-label="Search values" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <div className="eb-list" role="listbox" aria-label="Expression Values">
              {shown.map((v, i) => (
                <div
                  key={`${v.label}-${i}`}
                  role="option"
                  aria-selected={selected === v}
                  className={`eb-item ${selected?.label === v.label && selected.insert === v.insert ? "sel" : ""}`}
                  onClick={() => setSelected(v)}
                  onDoubleClick={() => insert(v)}
                >
                  {v.label}
                </div>
              ))}
              {!shown.length && <div className="eb-item muted">{filter ? "Nothing matches." : "(none)"}</div>}
            </div>
          </div>
        </div>
        <div className="eb-help">
          {selected ? (
            <>
              <div className="eb-help-row">
                <code className="eb-syntax">{selected.syntax ?? selected.insert.trim()}</code>
                <button className="eb-insert" onClick={() => insert(selected)}>
                  Insert
                </button>
              </div>
              <div>{selected.help}</div>
            </>
          ) : (
            <span className="muted">Pick an item to see what it does. Functions come with «placeholders»: click one (or press Tab) and type over it.</span>
          )}
        </div>
      </div>
    </Modal>
  );
}
