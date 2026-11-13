import { useEffect, useRef, useState } from "react";
import {
  defaultFieldProps,
  LOOKUP_TYPES,
  FIELD_TYPE_LABELS,
  FIELD_TYPES,
  INDEX_LABELS,
  INDEX_OPTIONS,
  NUMBER_SIZES,
  type Field,
  type FieldType,
  type ProjectDoc,
  type TableDef,
} from "../../../shared/model";
import { relationshipsBrokenBy } from "../engine/integrity";
import { useDialogs } from "../ui/dialogs";
import { ComboBox } from "../ui/ComboBox";
import { KeyIcon } from "../ui/icons";
import { useCommands, useWorkspace } from "../workspace/context";
import { changeFieldType, countLostOnTypeChange, deleteField, newId, renameField, uniqueFieldName, validateFieldName } from "../workspace/docOps";
import { LookupTab, LookupWizard, type WizardResult } from "./LookupProps";

// "Lookup Wizard..." sits in the Data Type list, as in Access.
const LOOKUP_WIZARD = "__lookup" as const;
const TYPE_OPTIONS: { value: FieldType | typeof LOOKUP_WIZARD; label: string }[] = [
  ...FIELD_TYPES.map((t) => ({ value: t, label: FIELD_TYPE_LABELS[t] })),
  { value: LOOKUP_WIZARD, label: "Lookup Wizard..." },
];
const NUMBER_SIZE_OPTIONS = NUMBER_SIZES.map((s) => ({ value: s, label: s === "Long" ? "Long Integer" : s }));
const YES_NO_OPTIONS = [
  { value: "No", label: "No" },
  { value: "Yes", label: "Yes" },
];
const INDEX_COMBO_OPTIONS = INDEX_OPTIONS.map((o) => ({ value: o, label: INDEX_LABELS[o] }));

const HELP: Record<string, string> = {
  name: "A field name can be up to 64 characters long, including spaces.",
  type: "The data type determines the kind of values that users can store in the field.",
  description: "The field description is optional. It helps you describe the field and is also displayed in the status bar.",
  size: "The maximum number of characters you can enter in the field. The largest maximum you can set is 255.",
  numberSize: "The size and type of numbers to enter in the field. Long Integer is the most common setting.",
  defaultValue: "A value that is automatically entered in this field for new records. Use =Now() or =Date() for the current date.",
  required: "Require data entry in this field?",
  indexed: "An index speeds up searches and sorting on the field, but may slow updates. 'Yes (No Duplicates)' prohibits duplicate values.",
};

/** The design grid's columns, left to right (by their labels), for arrow-key moves. */
const GRID_COLUMNS = ["Field Name", "Data Type", "Description"];

export function TableDesign({ table, tabKey }: { table: TableDef; tabKey: string }) {
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [help, setHelp] = useState(HELP.name);
  const [propsTab, setPropsTab] = useState<"general" | "lookup">("general");
  const [wizardFor, setWizardFor] = useState<string | null>(null);
  // Fields being dragged by their row selectors, and the row they'd go before.
  const [drag, setDrag] = useState<{ ids: string[]; to: number } | null>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const field: Field | undefined = table.fields[current];

  useEffect(() => {
    if (current > table.fields.length) setCurrent(table.fields.length);
  }, [table.fields.length, current]);

  const mutate = (fn: (t: TableDef, d: ProjectDoc) => unknown) =>
    ws.update((d) => {
      fn(d.tables.find((t) => t.id === table.id)!, d);
    });

  const setProp = <K extends keyof Field>(fieldId: string, key: K, value: Field[K]) =>
    mutate((t) => {
      const f = t.fields.find((x) => x.id === fieldId)!;
      if (value === undefined || value === "" || value === false) delete f[key];
      else f[key] = value;
    });

  const commitName = async (index: number, raw: string) => {
    const name = raw.trim();
    const existing = table.fields[index];
    if (existing && existing.name === name) return;
    if (!existing && !name) return;
    const err = validateFieldName(table, name, existing?.id);
    if (err) {
      await dialogs.alert("Microsoft Access Web", err);
      return;
    }
    if (existing) {
      mutate((t, d) => renameField(d, t, existing.id, name));
    } else {
      mutate((t) => {
        const f: Field = { id: newId("f"), name, type: "ShortText", ...defaultFieldProps("ShortText") };
        t.fields.push(f);
        for (const r of t.rows) r[f.id] = null;
      });
    }
  };

  /** Refuses a type or size change that would leave a relationship with mismatched types (Access refuses any). */
  const breaksRelationships = async (f: Field, change: Partial<Pick<Field, "type" | "numberSize">>, title = "Microsoft Access Web") => {
    const broken = relationshipsBrokenBy(ws.doc, table.id, f, change);
    if (!broken.length) return false;
    await dialogs.alert(
      title,
      `You can't change the ${change.type ? "data type" : "field size"} of '${f.name}' because it's related to ${broken.join(", ")}, and related fields must have the same data type. ` +
        `To change it, first delete the relationship in Database Tools → Relationships, change the field here, then relate the tables again.`,
    );
    return true;
  };

  const changeType = async (f: Field, type: FieldType) => {
    if (type !== f.type && (await breaksRelationships(f, { type }))) return;
    if (type === "AutoNumber") {
      if (table.fields.some((x) => x.type === "AutoNumber" && x.id !== f.id)) {
        await dialogs.alert("Microsoft Access Web", "A table can have only one AutoNumber field, and this one already has one.");
        return;
      }
      if (table.rows.length) {
        await dialogs.alert(
          "Microsoft Access Web",
          "A field can only become an AutoNumber while the table has no records. To number existing records, add a Number field instead.",
        );
        return;
      }
    }
    const lost = countLostOnTypeChange(table, f.id, type);
    if (lost > 0) {
      const ok = await dialogs.confirm(
        "Microsoft Access Web",
        `${lost} record(s) have values in ${f.name} that can't become ${FIELD_TYPE_LABELS[type]}, so those values would be cleared. Change the type anyway? (Undo, Ctrl+Z, brings them back.)`,
        { okLabel: "Yes", danger: true },
      );
      if (!ok) return;
    }
    mutate((t) => changeFieldType(t, f.id, type));
  };

  const togglePrimaryKey = async () => {
    const ids = selected.size ? [...selected] : field ? [field.id] : [];
    if (!ids.length) return;
    const already = ids.every((id) => table.fields.find((f) => f.id === id)?.primaryKey) &&
      table.fields.filter((f) => f.primaryKey).length === ids.length;
    if (!already) {
      // Check existing data can support the key.
      const keys = new Set<string>();
      for (const r of table.rows) {
        const parts = ids.map((id) => r[id]);
        if (parts.some((v) => v === null || v === undefined || v === "")) {
          await dialogs.alert("Microsoft Access Web", `A primary key can't have empty values, and some records have ${ids.map((id) => table.fields.find((f) => f.id === id)?.name).join(" or ")} empty. Please fill those in first.`);
          return;
        }
        const k = JSON.stringify(parts);
        if (keys.has(k)) {
          await dialogs.alert(
            "Microsoft Access Web",
            `A primary key must be unique, but some records have the same ${ids.map((id) => table.fields.find((f) => f.id === id)?.name).join(" + ")}${ids.length === 1 ? ` (${String(parts[0])})` : ""}. Please fix the duplicates first.`,
          );
          return;
        }
        keys.add(k);
      }
    }
    mutate((t) => {
      for (const f of t.fields) {
        if (already) delete f.primaryKey;
        else if (ids.includes(f.id)) {
          f.primaryKey = true;
          f.required = true;
        } else delete f.primaryKey;
      }
    });
  };

  const insertRow = () =>
    mutate((t) => {
      const f: Field = { id: newId("f"), name: uniqueFieldName(t), type: "ShortText", size: 255 };
      t.fields.splice(Math.min(current, t.fields.length), 0, f);
      for (const r of t.rows) r[f.id] = null;
    });

  const deleteRows = async () => {
    const ids = selected.size ? [...selected] : field ? [field.id] : [];
    if (!ids.length) return;
    const names = ids.map((id) => table.fields.find((f) => f.id === id)?.name).join(", ");
    const hasData = table.rows.some((r) => ids.some((id) => r[id] !== null && r[id] !== undefined && r[id] !== ""));
    const ok = await dialogs.confirm(
      "Microsoft Access Web",
      hasData
        ? `Do you want to permanently delete the selected field(s) (${names}) and all the data in them?`
        : `Delete the field(s) ${names}?`,
      { okLabel: "Yes", danger: true },
    );
    if (!ok) return;
    mutate((t, d) => ids.forEach((id) => deleteField(d, t, id)));
    setSelected(new Set());
  };

  /**
   * Applies the Lookup Wizard: the field takes the type of the field it stores (a key stored from
   * an AutoNumber is a Number), gets its lookup, and optionally a relationship to the source table.
   */
  const finishWizard = async (f: Field, r: WizardResult) => {
    const src = r.lookup.rowSourceType === "table" ? ws.doc.tables.find((t) => t.id === r.lookup.rowSource) : undefined;
    const bound = src?.fields.find((x) => x.name === r.lookup.boundColumn);
    let type: FieldType = f.type;
    if (bound) type = bound.type === "AutoNumber" || bound.type === "Number" ? "Number" : bound.type === "ShortText" ? "ShortText" : f.type;
    else if (r.lookup.rowSourceType === "values" && f.type !== "ShortText" && f.type !== "Number") type = "ShortText";
    if (!LOOKUP_TYPES.includes(type)) type = "ShortText";
    if (type !== f.type && (await breaksRelationships(f, { type }, "Lookup Wizard"))) return;
    if (type !== f.type) {
      const lost = countLostOnTypeChange(table, f.id, type);
      if (lost > 0) {
        const ok = await dialogs.confirm(
          "Lookup Wizard",
          `'${f.name}' becomes a ${FIELD_TYPE_LABELS[type]} field to match '${bound?.name}'. ${lost} record(s) have values that can't be converted and will be deleted. Continue?`,
          { okLabel: "Yes", danger: true },
        );
        if (!ok) return;
      }
    }
    // Data integrity needs a unique key and no values without a match.
    let enforce = false;
    let note = "";
    if (r.relate && src && bound) {
      const keys = new Set(src.rows.map((row) => String(row[bound.id] ?? "")));
      const orphans = table.rows.filter((row) => row[f.id] !== null && row[f.id] !== undefined && row[f.id] !== "" && !keys.has(String(row[f.id]))).length;
      const unique = bound.primaryKey || bound.indexed === "YesNoDup";
      enforce = unique && orphans === 0;
      if (!unique) note = ` The relationship doesn't enforce integrity because '${bound.name}' isn't a key or unique.`;
      else if (orphans) note = ` The relationship doesn't enforce integrity because ${orphans} record(s) have values not in '${src.name}'.`;
    }
    mutate((t, d) => {
      if (type !== f.type) changeFieldType(t, f.id, type);
      const field = t.fields.find((x) => x.id === f.id)!;
      if (type === "Number" && bound?.type === "Number" && bound.numberSize) field.numberSize = bound.numberSize;
      field.lookup = r.lookup;
      if (r.relate && src && bound) {
        d.relationships.push({ id: newId("rel"), fromTable: src.id, fromField: bound.id, toTable: t.id, toField: f.id, enforce });
      }
    });
    setPropsTab("lookup");
    ws.setStatus(
      `'${f.name}' now looks up ${src ? `'${src.name}'` : "its values"}${r.lookup.displayColumn ? `, showing ${r.lookup.displayColumn}` : ""}.` +
        (r.relate && src ? " Added a relationship." : "") +
        note,
    );
  };

  /**
   * Drag a row selector (or several selected rows) up or down to change the field order, like
   * Access. The order is the order of the datasheet's columns.
   */
  const startRowDrag = (e: React.PointerEvent, f: Field, index: number) => {
    if (e.button !== 0 || ws.readOnly) return;
    const ids = selected.has(f.id) ? table.fields.filter((x) => selected.has(x.id)).map((x) => x.id) : [f.id];
    const sy = e.clientY;
    let active = false;
    let to = index;
    const targetAt = (y: number) => {
      const rows = [...(bodyRef.current?.querySelectorAll<HTMLElement>("tr[data-field-row]") ?? [])];
      const i = rows.findIndex((r) => {
        const b = r.getBoundingClientRect();
        return y < b.top + b.height / 2;
      });
      return i < 0 ? rows.length : i;
    };
    const move = (ev: PointerEvent) => {
      if (!active && Math.abs(ev.clientY - sy) < 4) return;
      active = true;
      to = targetAt(ev.clientY);
      setDrag({ ids, to });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setDrag(null);
      if (!active) return;
      const order = table.fields.map((x) => x.id);
      const rest = order.filter((id) => !ids.includes(id));
      const at = to - order.slice(0, to).filter((id) => ids.includes(id)).length;
      const next = [...rest.slice(0, at), ...ids, ...rest.slice(at)];
      if (next.join() === order.join()) return;
      mutate((t) => {
        t.fields = next.map((id) => t.fields.find((x) => x.id === id)!);
      });
      setCurrent(at);
      ws.setStatus(`Moved ${ids.length === 1 ? `'${table.fields.find((x) => x.id === ids[0])?.name}'` : `${ids.length} fields`}. Datasheet View shows the fields in this order.`);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  useCommands(tabKey, { primaryKey: togglePrimaryKey, insertRows: insertRow, deleteRows });

  const rows = [...table.fields, undefined];

  return (
    <div className="design-view">
      <div className="design-grid-wrap">
        <table className="design-grid">
          <colgroup>
            <col style={{ width: 24 }} />
            <col style={{ width: "28%" }} />
            <col style={{ width: "18%" }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th />
              <th>Field Name</th>
              <th>Data Type</th>
              <th>Description (Optional)</th>
            </tr>
          </thead>
          <tbody
            ref={bodyRef}
            // Arrow keys move around the grid like a datasheet: ↑ ↓ to the field above or below (same
            // column), ← → to the column beside, wrapping to the next or previous field. In a text box,
            // ← → move within the text until the caret reaches its start or end (or all of it is selected).
            // A closed Data Type box is never changed by an arrow key.
            onKeyDownCapture={(e) => {
              const k = e.key;
              if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(k) || e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return;
              const el = e.target as HTMLElement;
              if (el.getAttribute("aria-expanded") === "true") return;
              const label = el.getAttribute("aria-label");
              const tr = el.closest("tr");
              if (!label || !tr || !GRID_COLUMNS.includes(label)) return;
              if ((k === "ArrowLeft" || k === "ArrowRight") && el instanceof HTMLInputElement) {
                const all = el.selectionStart === 0 && el.selectionEnd === el.value.length;
                const atEdge = el.selectionStart === el.selectionEnd && el.selectionStart === (k === "ArrowLeft" ? 0 : el.value.length);
                if (!all && !atEdge) return;
              }
              const cellIn = (row: Element | null, col: string) => row?.querySelector<HTMLElement>(`[aria-label="${col}"]`) ?? null;
              let target: HTMLElement | null = null;
              if (k === "ArrowUp" || k === "ArrowDown") {
                const next = k === "ArrowUp" ? tr.previousElementSibling : tr.nextElementSibling;
                target = cellIn(next, label) ?? cellIn(next, "Field Name");
              } else {
                const step = k === "ArrowRight" ? 1 : -1;
                // The next column in this row that's there; past the end, the next field's first (or the previous field's last).
                for (let i = GRID_COLUMNS.indexOf(label) + step; i >= 0 && i < GRID_COLUMNS.length && !target; i += step) target = cellIn(tr, GRID_COLUMNS[i]);
                if (!target) {
                  const row = step > 0 ? tr.nextElementSibling : tr.previousElementSibling;
                  const cols = step > 0 ? GRID_COLUMNS : [...GRID_COLUMNS].reverse();
                  for (const c of cols) if ((target = cellIn(row, c))) break;
                }
              }
              e.preventDefault();
              e.stopPropagation();
              if (!target) return;
              target.focus();
              if (target instanceof HTMLInputElement) target.select();
            }}
          >
            {rows.map((f, i) => (
              <tr
                // The blank row gets a new key once a field is added, so it starts empty instead of
                // keeping the text just typed into it.
                key={f?.id ?? `__new:${table.fields.length}`}
                data-field-row={f ? "" : undefined}
                className={`${i === current ? "row-current" : ""} ${f && selected.has(f.id) ? "row-selected" : ""} ${drag && drag.to === i ? "drop-before" : ""} ${f && drag?.ids.includes(f.id) ? "row-dragging" : ""}`}
                onFocusCapture={() => setCurrent(i)}
              >
                <td
                  className="row-selector"
                  title={f ? "Click to select the field; drag to move it" : undefined}
                  onPointerDown={(e) => f && startRowDrag(e, f, i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setCurrent(i);
                    if (!f) return;
                    setSelected((s) => {
                      if (e.ctrlKey || e.metaKey) {
                        const n = new Set(s);
                        if (n.has(f.id)) n.delete(f.id);
                        else n.add(f.id);
                        return n;
                      }
                      return new Set([f.id]);
                    });
                  }}
                >
                  {f?.primaryKey ? <KeyIcon size={13} /> : i === current ? "▶" : ""}
                </td>
                <td>
                  <input
                    className="grid-input"
                    defaultValue={f?.name ?? ""}
                    key={`${f?.id}:${f?.name}`}
                    aria-label="Field Name"
                    onFocus={() => setHelp(HELP.name)}
                    onBlur={(e) => commitName(i, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") {
                        (e.target as HTMLInputElement).value = f?.name ?? "";
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                </td>
                <td>
                  {f && (
                    <ComboBox
                      className="grid-input"
                      value={f.type}
                      ariaLabel="Data Type"
                      options={TYPE_OPTIONS}
                      onFocus={() => setHelp(HELP.type)}
                      onChange={(v) => (v === LOOKUP_WIZARD ? setWizardFor(f.id) : changeType(f, v))}
                    />
                  )}
                </td>
                <td>
                  {f && (
                    <input
                      className="grid-input"
                      defaultValue={f.description ?? ""}
                      key={`${f.id}:d:${f.description}`}
                      aria-label="Description"
                      maxLength={255}
                      onFocus={() => setHelp(HELP.description)}
                      onBlur={(e) => e.target.value !== (f.description ?? "") && setProp(f.id, "description", e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="field-props">
        <div className="field-props-head">Field Properties</div>
        <div className="field-props-body">
          <div className="props-tabs" role="tablist">
            <button role="tab" aria-selected={propsTab === "general"} className={`props-tab ${propsTab === "general" ? "active" : ""}`} onClick={() => setPropsTab("general")}>
              General
            </button>
            <button role="tab" aria-selected={propsTab === "lookup"} className={`props-tab ${propsTab === "lookup" ? "active" : ""}`} onClick={() => setPropsTab("lookup")}>
              Lookup
            </button>
          </div>
          <div className="props-columns">
            {field && propsTab === "lookup" ? (
              <table className="props-table" key={`${field.id}:lookup`}>
                <LookupTab
                  table={table}
                  field={field}
                  onHelp={setHelp}
                  onWizard={() => setWizardFor(field.id)}
                  onChange={(lookup) =>
                    mutate((t) => {
                      const f = t.fields.find((x) => x.id === field.id)!;
                      if (lookup) f.lookup = lookup;
                      else delete f.lookup;
                    })
                  }
                />
              </table>
            ) : field ? (
              <table className="props-table" key={field.id}>
                <tbody>
                  {field.type === "ShortText" && (
                    <PropRow label="Field Size" onFocus={() => setHelp(HELP.size)}>
                      <input
                        type="number"
                        min={1}
                        max={255}
                        defaultValue={field.size ?? 255}
                        onBlur={async (e) => {
                          const n = Math.max(1, Math.min(255, Math.round(Number(e.target.value)) || 255));
                          e.target.value = String(n);
                          if (n === (field.size ?? 255)) return;
                          const longer = table.rows.filter((r) => String(r[field.id] ?? "").length > n).length;
                          if (longer && !(await dialogs.confirm("Microsoft Access Web", `${longer} record(s) have values longer than ${n} characters and will be truncated. Continue?`, { okLabel: "Yes", danger: true }))) {
                            e.target.value = String(field.size ?? 255);
                            return;
                          }
                          mutate((t) => {
                            const f = t.fields.find((x) => x.id === field.id)!;
                            f.size = n;
                            for (const r of t.rows) if (typeof r[f.id] === "string") r[f.id] = (r[f.id] as string).slice(0, n);
                          });
                        }}
                      />
                    </PropRow>
                  )}
                  {field.type === "Number" && (
                    <PropRow label="Field Size" onFocus={() => setHelp(HELP.numberSize)}>
                      <ComboBox
                        value={field.numberSize ?? "Long"}
                        ariaLabel="Field Size"
                        options={NUMBER_SIZE_OPTIONS}
                        onChange={async (v) => {
                          if (!(await breaksRelationships(field, { numberSize: v as Field["numberSize"] }))) setProp(field.id, "numberSize", v);
                        }}
                      />
                    </PropRow>
                  )}
                  {field.type === "AutoNumber" && (
                    <>
                      <PropRow label="Field Size">
                        <span className="prop-static">Long Integer</span>
                      </PropRow>
                      <PropRow label="New Values">
                        <span className="prop-static">Increment (next: {table.nextAutoNumber})</span>
                      </PropRow>
                    </>
                  )}
                  {field.type === "Currency" && (
                    <PropRow label="Format">
                      <span className="prop-static">Currency</span>
                    </PropRow>
                  )}
                  {field.type === "DateTime" && (
                    <PropRow label="Format">
                      <span className="prop-static">General Date</span>
                    </PropRow>
                  )}
                  {field.type !== "AutoNumber" && field.type !== "Image" && (
                    <PropRow label="Default Value" onFocus={() => setHelp(HELP.defaultValue)}>
                      <input
                        defaultValue={field.defaultValue ?? ""}
                        maxLength={255}
                        onBlur={(e) => e.target.value !== (field.defaultValue ?? "") && setProp(field.id, "defaultValue", e.target.value)}
                      />
                    </PropRow>
                  )}
                  {field.type !== "AutoNumber" && field.type !== "YesNo" && (
                    <PropRow label="Required" onFocus={() => setHelp(HELP.required)}>
                      <ComboBox
                        value={field.required ? "Yes" : "No"}
                        ariaLabel="Required"
                        options={YES_NO_OPTIONS}
                        onChange={(v) => setProp(field.id, "required", v === "Yes")}
                      />
                    </PropRow>
                  )}
                  {field.type !== "LongText" && field.type !== "Image" && (
                    <PropRow label="Indexed" onFocus={() => setHelp(HELP.indexed)}>
                      <ComboBox
                        value={field.primaryKey ? "YesNoDup" : field.indexed ?? "No"}
                        ariaLabel="Indexed"
                        options={INDEX_COMBO_OPTIONS}
                        disabled={field.primaryKey}
                        onChange={async (v) => {
                          if (v === "YesNoDup") {
                            const vals = table.rows.map((r) => r[field.id]).filter((x) => x !== null && x !== "");
                            if (new Set(vals).size !== vals.length) {
                              await dialogs.alert("Microsoft Access Web", `${field.name} can't be set to "No Duplicates" yet, because some records already share the same value. Please fix the duplicates first.`);
                              return;
                            }
                          }
                          setProp(field.id, "indexed", v === "No" ? undefined : v);
                        }}
                      />
                    </PropRow>
                  )}
                </tbody>
              </table>
            ) : (
              <div className="prop-static pad">Type a field name in the empty row above to add a field.</div>
            )}
            <div className="props-help">{help}</div>
          </div>
        </div>
      </div>
      {wizardFor && table.fields.some((f) => f.id === wizardFor) && (
        <LookupWizard
          table={table}
          field={table.fields.find((f) => f.id === wizardFor)!}
          onClose={() => setWizardFor(null)}
          onFinish={(r) => {
            const f = table.fields.find((x) => x.id === wizardFor)!;
            setWizardFor(null);
            void finishWizard(f, r);
          }}
        />
      )}
    </div>
  );
}

function PropRow({ label, children, onFocus }: { label: string; children: React.ReactNode; onFocus?: () => void }) {
  return (
    <tr onFocusCapture={onFocus}>
      <th>{label}</th>
      <td>{children}</td>
    </tr>
  );
}
