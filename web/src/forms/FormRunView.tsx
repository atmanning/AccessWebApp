/** Form View: the designed form, bound to one record at a time. */
import { Fragment, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import type { CellValue, Field, FormControl, FormDef, ProjectDoc } from "../../../shared/model";
import { readSource } from "../engine/engine";
import { formatValue } from "../engine/values";
import { useLayout } from "../ui/layout";
import { useSource } from "../views/FormReportViews";
import { useCommands, useWorkspace } from "../workspace/context";
import { useTableEditing } from "../workspace/useTableEditing";
import { FormControlView, type ChoiceOption } from "./FormControls";
import { isBound, layoutOf, parseValueList, readingOrder, themeStyle } from "./formLayout";

/** Choices for combo and list boxes, by control id. Table and query row sources are read once per change. */
export function useRowSources(doc: ProjectDoc, controls: FormControl[]) {
  const lists = controls.filter((c) => c.type === "combobox" || c.type === "listbox");
  const lookups = lists.filter((c) => (c.rowSourceType === "table" || c.rowSourceType === "query") && c.rowSource);
  const key = lookups.map((c) => `${c.id}:${c.rowSourceType}:${c.rowSource}:${c.boundColumn ?? ""}:${c.displayColumn ?? ""}`).join("|");
  const [loaded, setLoaded] = useState<Record<string, ChoiceOption[]>>({});
  const sourceDeps = lookups.map((c) => (c.rowSourceType === "table" ? doc.tables.find((t) => t.id === c.rowSource) : doc.queries.find((q) => q.id === c.rowSource)));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: Record<string, ChoiceOption[]> = {};
      for (const c of lookups) {
        try {
          const data = await readSource(doc, { kind: c.rowSourceType as "table" | "query", id: c.rowSource! });
          const find = (n?: string) => (n ? data.columns.findIndex((x) => x.toLowerCase() === n.toLowerCase()) : -1);
          const bi = Math.max(0, find(c.boundColumn));
          let di = find(c.displayColumn);
          if (di < 0) di = data.columns.length > 1 && !c.boundColumn ? 1 : bi;
          const seen = new Set<string>();
          out[c.id] = [];
          for (const r of data.rows) {
            const v = r[bi] === null ? "" : String(r[bi]);
            if (seen.has(v)) continue;
            seen.add(v);
            out[c.id].push({ value: v, label: formatValue(data.fields[di], r[di]) });
          }
        } catch {
          out[c.id] = [];
        }
      }
      if (!cancelled) setLoaded(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [key, ...sourceDeps]); // eslint-disable-line react-hooks/exhaustive-deps

  const result: Record<string, ChoiceOption[]> = {};
  for (const c of lists) {
    result[c.id] = c.rowSourceType === "table" || c.rowSourceType === "query" ? (loaded[c.id] ?? []) : parseValueList(c.rowSource).map((v) => ({ value: v, label: v }));
  }
  return result;
}

export function FormRunView({ form, tabKey }: { form: FormDef; tabKey: string }) {
  const ws = useWorkspace();
  const { compact } = useLayout();
  const { data, error, table } = useSource(form.source);
  const editing = useTableEditing(table);
  const [pos, setPos] = useState(0);
  const [isNew, setIsNew] = useState(false);
  const [fieldError, setFieldError] = useState<{ id: string; msg: string } | null>(null);
  const count = data?.rows.length ?? 0;

  const fieldList = useMemo(() => (data ? data.columns.map((name, i) => ({ name, field: data.fields[i] })) : []), [data]);
  const layout = useMemo(() => layoutOf(form, fieldList), [form, fieldList]);
  const options = useRowSources(ws.doc, layout.controls);
  const canAdd = !!table && !ws.readOnly && layout.allowAdditions !== false;
  const canDelete = !!table && !ws.readOnly && layout.allowDeletions !== false;

  useEffect(() => {
    if (pos >= count && count > 0 && !isNew) setPos(count - 1);
  }, [count, pos, isNew]);
  // An empty table opens on a new record, like Access.
  useEffect(() => {
    if (data && count === 0 && canAdd) setIsNew(true);
  }, [data, count, canAdd]);

  const go = (n: number) => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    setIsNew(false);
    setFieldError(null);
    setPos(Math.max(0, Math.min(count - 1, n)));
  };
  const goNew = () => {
    if (!table) return ws.setStatus("This form shows a query, so records can't be added here.", "error");
    if (!canAdd) return ws.setStatus("This form doesn't allow new records.", "error");
    (document.activeElement as HTMLElement | null)?.blur?.();
    setFieldError(null);
    setIsNew(true);
  };
  const deleteRecord = async () => {
    if (!canDelete) return ws.setStatus(table ? "This form doesn't allow deleting records." : "This form shows a query, so records can't be deleted here.", "error");
    if (isNew) return go(count - 1);
    if (!count) return;
    if (await editing.deleteRows([pos])) setPos((p) => Math.max(0, Math.min(p, count - 2)));
  };

  useCommands(tabKey, { newRecord: goNew, deleteRecord });

  if (error) return <div className="query-error"><strong>This form can't open.</strong><p>{error}</p></div>;
  if (!data) return <div className="empty-view">Loading…</div>;

  const colIdx = (name: string) => data.columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());
  const row = isNew ? null : data.rows[pos];

  const save = (c: FormControl, field: Field, input: string | boolean) => {
    const err = editing.commit(isNew ? "new" : pos, field.id, input);
    if (err) {
      setFieldError({ id: c.id, msg: err });
      ws.setStatus(err, "error");
      return;
    }
    setFieldError(null);
    if (isNew) {
      setIsNew(false);
      setPos(count); // the record that was just added
    }
  };

  const act = (c: FormControl) => {
    switch (c.action) {
      case "firstRecord": return go(0);
      case "previousRecord": return go(isNew ? count - 1 : pos - 1);
      case "nextRecord": return go(pos + 1);
      case "lastRecord": return go(count - 1);
      case "newRecord": return goNew();
      case "deleteRecord": return void deleteRecord();
      case "saveRecord":
        (document.activeElement as HTMLElement | null)?.blur?.();
        return ws.setStatus("Record saved.");
      case "openForm":
      case "openReport": {
        const kind = c.action === "openForm" ? "form" : "report";
        const list = kind === "form" ? ws.doc.forms : ws.doc.reports;
        if (c.target && list.some((x) => x.id === c.target)) ws.openObject(kind, c.target);
        else ws.setStatus(`Choose the ${kind} this button opens (Design View, button's On Click property).`, "error");
        return;
      }
      case "closeForm": return ws.closeTab(tabKey);
    }
  };
  const buttonDisabled = (c: FormControl) => {
    switch (c.action) {
      case "firstRecord":
      case "previousRecord": return !isNew && pos <= 0;
      case "nextRecord":
      case "lastRecord": return isNew || pos >= count - 1;
      case "newRecord": return !canAdd || isNew;
      case "deleteRecord": return !canDelete || (!count && !isNew);
      default: return false;
    }
  };

  const renderControl = (c: FormControl) => {
    if (c.hidden) return null;
    const inputId = `fv-${form.id}-${c.id}`;
    if (!isBound(c.type)) return <FormControlView c={c} inputId={inputId} run={{ value: null, readOnly: true, isNew, onCommit: () => {}, onAction: () => act(c), buttonDisabled: buttonDisabled(c) }} />;
    const i = c.field ? colIdx(c.field) : -1;
    const field = i >= 0 ? data.fields[i] : undefined;
    const value: CellValue = row && i >= 0 ? row[i] : null;
    const readOnly =
      ws.readOnly || !table || !field || field.type === "AutoNumber" || !!c.locked || (!isNew && layout.allowEdits === false) || (isNew && !canAdd);
    return (
      <FormControlView
        c={c}
        inputId={inputId}
        run={{
          value,
          field,
          missing: !!c.field && i < 0,
          readOnly,
          isNew,
          error: fieldError?.id === c.id ? fieldError.msg : null,
          options: options[c.id],
          onCommit: (input) => field && save(c, field, input),
          onAction: () => {},
        }}
      />
    );
  };

  // Enter moves to the next control, like Access (Shift+Enter goes back).
  const onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (e.key !== "Enter" || t.tagName === "TEXTAREA" || t.tagName === "BUTTON" || e.ctrlKey || e.altKey) return;
    const root = e.currentTarget as HTMLElement;
    const items = [...root.querySelectorAll<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea, [role=listbox][tabindex='0']")];
    const i = items.indexOf(t);
    if (i < 0) return;
    e.preventDefault();
    const next = items[i + (e.shiftKey ? -1 : 1)];
    if (next) next.focus();
    else t.blur();
  };

  // Remount a control when its record or value changes (undo, another control), so it shows the saved value.
  const valueKey = (c: FormControl) => {
    const i = c.field ? colIdx(c.field) : -1;
    return `${c.id}-${recordKey}-${row && i >= 0 ? String(row[i]) : ""}`;
  };
  const recordKey = isNew ? "new" : `${pos}`;
  const sectionHeight = (s: "header" | "detail" | "footer") => layout.sections[s];
  const ordered = readingOrder(layout.controls);

  const sectionBody = (s: "header" | "detail" | "footer") => {
    const list = ordered.filter((c) => c.section === s && !c.hidden);
    if (!compact) {
      return list.map((c) => (
        <div key={valueKey(c)} className={`fv-ctl t-${c.type}`} style={{ left: c.x, top: c.y, width: c.w, height: c.h }}>
          {renderControl(c)}
        </div>
      ));
    }
    // Phone: the controls in reading order, full width; buttons side by side.
    const out: ReactNode[] = [];
    let buttons: FormControl[] = [];
    const flush = () => {
      if (buttons.length) {
        out.push(
          <div key={`b-${buttons[0].id}`} className="fv-btn-row">
            {buttons.map((b) => <Fragment key={b.id}>{renderControl(b)}</Fragment>)}
          </div>,
        );
      }
      buttons = [];
    };
    for (const c of list) {
      if (c.type === "rectangle" || c.type === "line") continue;
      if (c.type === "button") {
        buttons.push(c);
        continue;
      }
      flush();
      out.push(
        <div key={valueKey(c)} className={`fv-ctl flow t-${c.type}`} style={c.multiline || c.type === "listbox" ? { minHeight: c.h } : undefined}>
          {renderControl(c)}
        </div>,
      );
    }
    flush();
    return out;
  };

  return (
    <div className={`fv theme-${layout.theme} ${compact ? "compact" : ""}`} style={themeStyle(layout.theme)}>
      <div className="fv-scroll">
        <div className="fv-card" style={compact ? undefined : { width: layout.width }} onKeyDown={onKeyDown}>
          {(["header", "detail", "footer"] as const).map((s) =>
            sectionHeight(s) > 0 ? (
              <div key={s} className={`fv-section fv-${s}`} style={compact ? undefined : { height: sectionHeight(s) }}>
                {sectionBody(s)}
              </div>
            ) : null,
          )}
        </div>
      </div>
      {layout.navigationButtons !== false && (
        <div className="record-nav">
          <span className="rn-label">Record:</span>
          <button onClick={() => go(0)} disabled={!count} title="First record">⏮</button>
          <button onClick={() => go(isNew ? count - 1 : pos - 1)} disabled={!isNew && pos <= 0} title="Previous record">◀</button>
          <span className="rn-pos static">{isNew ? `${count + 1} of ${count + 1}` : `${count ? pos + 1 : 0} of ${count}`}</span>
          <button onClick={() => go(pos + 1)} disabled={isNew || pos >= count - 1} title="Next record">▶</button>
          <button onClick={() => go(count - 1)} disabled={!count} title="Last record">⏭</button>
          <button onClick={goNew} disabled={!canAdd} title="New (blank) record">▶*</button>
          {!table && <span className="rn-filter">Read-only (query)</span>}
        </div>
      )}
    </div>
  );
}
