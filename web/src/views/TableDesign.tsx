import { useEffect, useState } from "react";
import {
  defaultFieldProps,
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
import { useDialogs } from "../ui/dialogs";
import { KeyIcon } from "../ui/icons";
import { useCommands, useWorkspace } from "../workspace/context";
import { changeFieldType, countLostOnTypeChange, deleteField, newId, renameField, uniqueFieldName, validateFieldName } from "../workspace/docOps";

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

export function TableDesign({ table, tabKey }: { table: TableDef; tabKey: string }) {
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [help, setHelp] = useState(HELP.name);
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

  const changeType = async (f: Field, type: FieldType) => {
    if (type === "AutoNumber") {
      if (table.fields.some((x) => x.type === "AutoNumber" && x.id !== f.id)) {
        await dialogs.alert("Microsoft Access Web", "A table can have only one AutoNumber field.");
        return;
      }
      if (table.rows.length) {
        await dialogs.alert(
          "Microsoft Access Web",
          "Once you enter data in a table, you can't change the data type of any field to AutoNumber, even if you haven't yet added data to that field.",
        );
        return;
      }
    }
    const lost = countLostOnTypeChange(table, f.id, type);
    if (lost > 0) {
      const ok = await dialogs.confirm(
        "Microsoft Access Web",
        `Some data may be lost. ${lost} record(s) contain values in '${f.name}' that can't be converted to ${FIELD_TYPE_LABELS[type]} and will be deleted. Do you want to continue anyway?`,
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
          await dialogs.alert("Microsoft Access Web", "Index or primary key cannot contain a Null value. Fill in the empty values first.");
          return;
        }
        const k = JSON.stringify(parts);
        if (keys.has(k)) {
          await dialogs.alert(
            "Microsoft Access Web",
            "The changes you requested to the table were not successful because they would create duplicate values in the primary key.",
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
          <tbody>
            {rows.map((f, i) => (
              <tr
                key={f?.id ?? "__new"}
                className={`${i === current ? "row-current" : ""} ${f && selected.has(f.id) ? "row-selected" : ""}`}
                onFocusCapture={() => setCurrent(i)}
              >
                <td
                  className="row-selector"
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
                    <select
                      className="grid-input"
                      value={f.type}
                      aria-label="Data Type"
                      onFocus={() => setHelp(HELP.type)}
                      onChange={(e) => changeType(f, e.target.value as FieldType)}
                    >
                      {FIELD_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {FIELD_TYPE_LABELS[t]}
                        </option>
                      ))}
                    </select>
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
          <div className="props-tabs">
            <span className="props-tab active">General</span>
          </div>
          <div className="props-columns">
            {field ? (
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
                      <select value={field.numberSize ?? "Long"} onChange={(e) => setProp(field.id, "numberSize", e.target.value as Field["numberSize"])}>
                        {NUMBER_SIZES.map((s) => (
                          <option key={s} value={s}>
                            {s === "Long" ? "Long Integer" : s}
                          </option>
                        ))}
                      </select>
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
                  {field.type !== "AutoNumber" && (
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
                      <select value={field.required ? "Yes" : "No"} onChange={(e) => setProp(field.id, "required", e.target.value === "Yes")}>
                        <option>No</option>
                        <option>Yes</option>
                      </select>
                    </PropRow>
                  )}
                  {field.type !== "LongText" && (
                    <PropRow label="Indexed" onFocus={() => setHelp(HELP.indexed)}>
                      <select
                        value={field.primaryKey ? "YesNoDup" : field.indexed ?? "No"}
                        disabled={field.primaryKey}
                        onChange={async (e) => {
                          const v = e.target.value as Field["indexed"];
                          if (v === "YesNoDup") {
                            const vals = table.rows.map((r) => r[field.id]).filter((x) => x !== null && x !== "");
                            if (new Set(vals).size !== vals.length) {
                              await dialogs.alert("Microsoft Access Web", `'${field.name}' already contains duplicate values, so it can't be indexed with No Duplicates.`);
                              return;
                            }
                          }
                          setProp(field.id, "indexed", v === "No" ? undefined : v);
                        }}
                      >
                        {INDEX_OPTIONS.map((o) => (
                          <option key={o} value={o}>
                            {INDEX_LABELS[o]}
                          </option>
                        ))}
                      </select>
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
