/** Form View: the designed form, bound to one record at a time. */
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { CellValue, Field, FormControl, FormDef, ProjectDoc } from "../../../shared/model";
import { readSource } from "../engine/engine";
import { formatValue } from "../engine/values";
import { compileCriteria } from "../engine/findCriteria";
import { isExpression } from "../engine/expr";
import { makeFormCalc } from "./formCalc";
import { SubformView } from "./subform";
import { useLayout } from "../ui/layout";
import { useSource } from "../views/FormReportViews";
import { useCommands, useWorkspace, type RecordTarget } from "../workspace/context";
import { useTableEditing } from "../workspace/useTableEditing";
import { FormControlView, type ChoiceOption } from "./FormControls";
import { isBound, layoutOf, parseValueList, readingOrder, tabSequence, themeStyle } from "./formLayout";

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

/** Criteria typed in Find mode, by field name; several requests are ORed (Access's "Or" tabs). */
type FindRequest = Record<string, string>;

export function FormRunView({ form, tabKey, goto }: { form: FormDef; tabKey: string; goto?: RecordTarget }) {
  const ws = useWorkspace();
  const { compact } = useLayout();
  const { data, error, table } = useSource(form.source);
  const editing = useTableEditing(table);
  /** Position in the found (filtered and sorted) records. */
  const [pos, setPos] = useState(0);
  const [isNew, setIsNew] = useState(false);
  const [fieldError, setFieldError] = useState<{ id: string; msg: string } | null>(null);

  // ---- Find mode (Filter by Form): type criteria into the form's own fields ----
  const [finding, setFinding] = useState<{ requests: FindRequest[]; active: number; message?: string } | null>(null);
  const [filter, setFilter] = useState<FindRequest[] | null>(null);
  const [filterOn, setFilterOn] = useState(false);
  // Records added or edited while filtered stay in view until the filter is applied again, as in Access.
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ field: string; dir: "ASC" | "DESC" } | null>(null);
  const [focusField, setFocusField] = useState<string | null>(null);
  const [addedAt, setAddedAt] = useState<number | null>(null);

  const fieldList = useMemo(() => (data ? data.columns.map((name, i) => ({ name, field: data.fields[i] })) : []), [data]);
  const layout = useMemo(() => layoutOf(form, fieldList), [form, fieldList]);
  const options = useRowSources(ws.doc, layout.controls);
  const canAdd = !!table && !ws.readOnly && layout.allowAdditions !== false;
  const canDelete = !!table && !ws.readOnly && layout.allowDeletions !== false;

  const colOf = (name: string) => (data ? data.columns.findIndex((c) => c.toLowerCase() === name.toLowerCase()) : -1);
  const keyOf = (i: number) => (table ? String(table.rows[i]?._id ?? i) : String(i));
  // What a lookup (combo/list box) shows for each stored value, by field name.
  const shownBy = useMemo(() => {
    const out = new Map<string, Map<string, string>>();
    for (const c of layout.controls) {
      const opts = options[c.id];
      if (c.field && opts?.length && !out.has(c.field.toLowerCase())) out.set(c.field.toLowerCase(), new Map(opts.map((o) => [o.value, o.label])));
    }
    return out;
  }, [layout.controls, options]);

  /** Turns Find requests into one test per record; an error names the field and what's wrong. */
  const compileFind = (requests: FindRequest[]) => {
    const tests: ((i: number) => boolean)[] = [];
    for (const req of requests) {
      const parts: ((i: number) => boolean)[] = [];
      for (const [name, text] of Object.entries(req)) {
        if (!text.trim()) continue;
        const ci = colOf(name);
        if (ci < 0 || !data) continue;
        const shown = shownBy.get(name.toLowerCase());
        const c = compileCriteria(text, { type: data.fields[ci]?.type ?? "ShortText", name }, { lookup: !!shown });
        if (!c.ok) return { error: c.error };
        parts.push((i) => {
          const v = data.rows[i][ci];
          return c.test(v, shown && v !== null && v !== undefined ? shown.get(String(v)) : undefined);
        });
      }
      if (parts.length) tests.push((i) => parts.every((t) => t(i)));
    }
    return { test: tests.length ? (i: number) => tests.some((t) => t(i)) : null };
  };

  const order = useMemo(() => {
    if (!data) return [];
    let idx = data.rows.map((_, i) => i);
    if (filterOn && filter) {
      const f = compileFind(filter);
      if ("test" in f && f.test) idx = idx.filter((i) => kept.has(keyOf(i)) || f.test!(i));
    }
    if (sort) {
      const ci = colOf(sort.field);
      const shown = shownBy.get(sort.field.toLowerCase());
      const dir = sort.dir === "ASC" ? 1 : -1;
      const val = (i: number) => {
        const v = data.rows[i][ci];
        return shown && v !== null && v !== undefined ? (shown.get(String(v)) ?? v) : v;
      };
      idx.sort((a, b) => {
        const va = val(a);
        const vb = val(b);
        if (va === null || va === undefined || va === "") return vb === null || vb === undefined || vb === "" ? 0 : -dir;
        if (vb === null || vb === undefined || vb === "") return dir;
        if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
        return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" }) * dir;
      });
    }
    return idx;
  }, [data, filter, filterOn, kept, sort, shownBy]); // eslint-disable-line react-hooks/exhaustive-deps
  const count = order.length;

  useEffect(() => {
    if (pos >= count && count > 0 && !isNew) setPos(count - 1);
  }, [count, pos, isNew]);
  // An empty table opens on a new record, like Access.
  useEffect(() => {
    if (data && !data.rows.length && canAdd) setIsNew(true);
  }, [data, canAdd]);
  // A record just added: keep it in view (even when filtered) and go to it.
  useEffect(() => {
    if (addedAt === null || !data || addedAt >= data.rows.length) return;
    if (filterOn) setKept((k) => new Set(k).add(keyOf(addedAt)));
    const p = order.indexOf(addedAt);
    if (p >= 0) {
      setPos(p);
      setAddedAt(null);
    }
  }, [data, order, addedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opened at one record (a label's QR code): find it by its key and show it, even if filtered out.
  useEffect(() => {
    if (!goto || !data) return;
    const ci = colOf(goto.field);
    const i = ci < 0 ? -1 : data.rows.findIndex((r) => String(r[ci] ?? "") === goto.value);
    if (i < 0) return ws.setStatus(`There's no record with ${goto.field} ${goto.value} any more.`, "error");
    setFinding(null);
    setIsNew(false);
    setAddedAt(i);
    const shown = layout.controls.filter((c) => c.field && !isExpression(c.field) && isBound(c.type) && c.type !== "image" && c.field.toLowerCase() !== goto.field.toLowerCase()).slice(0, 2).map((c) => data.rows[i][colOf(c.field!)]);
    ws.setStatus(`Opened ${shown.filter((v) => v !== null && v !== "").join(" ") || "the record"} from its link.`);
  }, [goto?.n, data === undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (n: number) => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    setIsNew(false);
    setFieldError(null);
    setPos(Math.max(0, Math.min(count - 1, n)));
  };
  const goNew = () => {
    if (finding) return;
    if (!table) return ws.setStatus("This form shows a query, so records can't be added here.", "error");
    if (!canAdd) return ws.setStatus("This form doesn't allow new records.", "error");
    (document.activeElement as HTMLElement | null)?.blur?.();
    setFieldError(null);
    setIsNew(true);
  };
  const deleteRecord = async () => {
    if (finding) return;
    if (!canDelete) return ws.setStatus(table ? "This form doesn't allow deleting records." : "This form shows a query, so records can't be deleted here.", "error");
    if (isNew) return go(count - 1);
    if (!count) return;
    if (await editing.deleteRows([order[pos]])) setPos((p) => Math.max(0, Math.min(p, count - 2)));
  };

  const startFind = () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    setFieldError(null);
    setIsNew(false);
    // Start from the filter in use, so it can be changed rather than typed again.
    setFinding({ requests: filter && filterOn ? filter.map((r) => ({ ...r })) : [{}], active: 0 });
    ws.setStatus("Find: type what you're looking for in any field, then press Enter.");
  };
  const runFind = () => {
    if (!finding) return;
    const requests = finding.requests.filter((r) => Object.values(r).some((v) => v.trim()));
    if (!requests.length) {
      setFinding(null);
      setFilterOn(false);
      return ws.setStatus("Showing all records.");
    }
    const f = compileFind(requests);
    if ("error" in f) return setFinding({ ...finding, message: f.error });
    const found = data ? data.rows.filter((_, i) => f.test!(i)).length : 0;
    if (!found) return setFinding({ ...finding, message: "No records match. Change what you typed, or press Esc to go back." });
    setFilter(requests);
    setFilterOn(true);
    setKept(new Set());
    setFinding(null);
    setPos(0);
    ws.setStatus(`Found ${found} of ${data!.rows.length} record(s). Toggle Filter (or "Filtered" below) shows all of them again.`);
  };
  const toggleFilter = () => {
    if (finding) return runFind();
    if (!filter) return startFind();
    setFilterOn((on) => !on);
    setKept(new Set());
    setPos(0);
    ws.setStatus(filterOn ? "Showing all records." : "Filter applied again.");
  };
  const sortBy = (dir: "ASC" | "DESC" | null) => {
    if (!dir) return setSort(null), ws.setStatus("Removed the sort.");
    const field = focusField ?? layout.controls.find((c) => c.field && !isExpression(c.field) && isBound(c.type))?.field;
    if (!field) return;
    setSort({ field, dir });
    setPos(0);
    ws.setStatus(`Sorted by ${field} (${dir === "ASC" ? "A→Z" : "Z→A"}). Click in another field first to sort by it.`);
  };

  // Controls with Tab Stop = No: Tab (and Enter) pass over them; a click still works.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.querySelectorAll<HTMLElement>(".no-tab").forEach((box) =>
      box.querySelectorAll<HTMLElement>("input, select, textarea, button, [tabindex]").forEach((el) => (el.tabIndex = -1)),
    );
  });

  const calc = useMemo(() => (data ? makeFormCalc(ws.doc, layout, data.columns) : null), [ws.doc, layout, data]);

  useCommands(tabKey, {
    newRecord: goNew,
    deleteRecord,
    find: startFind,
    filterByForm: startFind,
    toggleFilter,
    filterOn: !!finding || filterOn,
    sortAsc: () => sortBy("ASC"),
    sortDesc: () => sortBy("DESC"),
    removeSort: () => sortBy(null),
  });

  if (error) return <div className="query-error"><strong>This form can't open.</strong><p>{error}</p></div>;
  if (!data) return <div className="empty-view">Loading…</div>;

  const colIdx = colOf;
  const rowIndex = order[pos];
  const row = isNew || rowIndex === undefined ? null : data.rows[rowIndex];
  /** The records the form shows (for Sum, Count… in calculated controls). */
  const foundRows = () => order.map((i) => data.rows[i]);

  const save = (c: FormControl, field: Field, input: string | boolean) => {
    const err = editing.commit(isNew ? "new" : rowIndex, field.id, input);
    if (err) {
      setFieldError({ id: c.id, msg: err });
      ws.setStatus(err, "error");
      return;
    }
    setFieldError(null);
    if (isNew) {
      setIsNew(false);
      setAddedAt(data.rows.length); // the record that was just added
    } else if (filterOn) setKept((k) => new Set(k).add(keyOf(rowIndex)));
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
    if (c.type === "subform") {
      // Related records of this record (Link Child Fields = this record's Link Master Fields).
      const mi = c.linkMaster ? colIdx(c.linkMaster) : -1;
      const master = c.linkMaster ? (row && mi >= 0 ? row[mi] : undefined) : null;
      const content = finding ? (
        <div className="sf-box sf-message">Related records aren't searched in Find.</div>
      ) : (
        <SubformView c={c} master={master} newRecord={isNew} masterMissing={!!c.linkMaster && mi < 0} readOnly={layout.allowEdits === false} />
      );
      return <FormControlView c={c} inputId={inputId} run={{ value: null, readOnly: true, isNew, content, onCommit: () => {}, onAction: () => {} }} />;
    }
    if (isExpression(c.field)) {
      // Calculated: worked out from the record; nothing to type (or search) here.
      const r = finding ? { text: "", value: null } : calc ? calc.value(c, row, foundRows) : { text: "", value: null };
      return <FormControlView c={c} inputId={inputId} run={{ value: null, readOnly: true, isNew, display: { text: r.text, error: "error" in r ? r.error : undefined, numeric: typeof r.value === "number" }, onCommit: () => {}, onAction: () => {} }} />;
    }
    if (finding && isBound(c.type)) return <FindField c={c} inputId={inputId} field={c.field ? data.fields[colIdx(c.field)] : undefined} finding={finding} setFinding={setFinding} options={options[c.id]} onEnter={runFind} />;
    if (!isBound(c.type)) return <FormControlView c={c} inputId={inputId} run={{ value: null, readOnly: true, isNew, onCommit: () => {}, onAction: () => act(c), buttonDisabled: !!finding || buttonDisabled(c) }} />;
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
          imageUrl: (imageId: string) => ws.imageUrl(imageId),
          uploadImage: ws.readOnly ? undefined : ws.uploadImage,
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
    const items = [...root.querySelectorAll<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea, [role=listbox][tabindex='0']")].filter((el) => el.tabIndex >= 0 || el === t);
    const i = items.indexOf(t);
    if (i < 0) return;
    e.preventDefault();
    const next = items[i + (e.shiftKey ? -1 : 1)];
    if (next) next.focus();
    else t.blur();
  };

  // Remount a control when its record or value changes (undo, another control), so it shows the saved value.
  const valueKey = (c: FormControl) => {
    if (finding) return `${c.id}-find-${finding.active}`;
    const i = c.field ? colIdx(c.field) : -1;
    return `${c.id}-${recordKey}-${row && i >= 0 ? String(row[i]) : ""}`;
  };
  const recordKey = isNew ? "new" : `${pos}`;
  const sectionHeight = (s: "header" | "detail" | "footer") => layout.sections[s];
  // Desktop: the controls go into the page in tab order, so Tab follows it; phones stack them top to bottom.
  const ordered = compact ? readingOrder(layout.controls) : tabSequence(layout);

  const sectionBody = (s: "header" | "detail" | "footer") => {
    const list = ordered.filter((c) => c.section === s && !c.hidden);
    if (!compact) {
      return list.map((c) => (
        <div key={valueKey(c)} className={`fv-ctl t-${c.type} ${c.tabStop === false ? "no-tab" : ""}`} data-field={isExpression(c.field) ? undefined : c.field} style={{ left: c.x, top: c.y, width: c.w, height: c.h }}>
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
        <div key={valueKey(c)} className={`fv-ctl flow t-${c.type} ${c.tabStop === false ? "no-tab" : ""}`} data-field={isExpression(c.field) ? undefined : c.field} style={c.multiline || c.type === "listbox" || c.type === "image" || c.type === "subform" ? { minHeight: c.h } : undefined}>
          {renderControl(c)}
        </div>,
      );
    }
    flush();
    return out;
  };

  return (
    <div ref={rootRef} className={`fv theme-${layout.theme} ${compact ? "compact" : ""} ${finding ? "finding" : ""}`} style={themeStyle(layout.theme)}>
      {finding && (
        <FindBar
          finding={finding}
          setFinding={setFinding}
          onFind={runFind}
          onCancel={() => {
            setFinding(null);
            ws.setStatus(filterOn ? "Kept the filter you had." : "");
          }}
        />
      )}
      <div className="fv-scroll">
        <div
          className="fv-card"
          style={compact ? undefined : { width: layout.width }}
          onKeyDown={(e) => {
            if (finding && e.key === "Escape") {
              e.preventDefault();
              setFinding(null);
              return;
            }
            onKeyDown(e);
          }}
          onFocusCapture={(e) => {
            const f = (e.target as HTMLElement).closest<HTMLElement>("[data-field]")?.dataset.field;
            if (f) setFocusField(f);
          }}
        >
          {(["header", "detail", "footer"] as const).map((s) =>
            sectionHeight(s) > 0 ? (
              <div key={s} className={`fv-section fv-${s}`} style={compact ? undefined : { height: sectionHeight(s) }}>
                {sectionBody(s)}
              </div>
            ) : null,
          )}
        </div>
      </div>
      {!finding && (layout.navigationButtons !== false || filter) && (
        <div className="record-nav">
          <span className="rn-label">Record:</span>
          <button onClick={() => go(0)} disabled={!count} title="First record">⏮</button>
          <button onClick={() => go(isNew ? count - 1 : pos - 1)} disabled={!isNew && pos <= 0} title="Previous record">◀</button>
          <span className="rn-pos static">{isNew ? `${count + 1} of ${count + 1}` : `${count ? pos + 1 : 0} of ${count}`}</span>
          <button onClick={() => go(pos + 1)} disabled={isNew || pos >= count - 1} title="Next record">▶</button>
          <button onClick={() => go(count - 1)} disabled={!count} title="Last record">⏭</button>
          <button onClick={goNew} disabled={!canAdd} title="New (blank) record">▶*</button>
          {filter && (
            <button
              className={`rn-filter-toggle ${filterOn ? "on" : ""}`}
              onClick={toggleFilter}
              title={filterOn ? "Showing the records that match your Find. Click to show all records." : "Click to apply your last Find again."}
            >
              {filterOn ? "Filtered" : "Unfiltered"}
            </button>
          )}
          <button className="rn-find" onClick={startFind} title="Find records: type what you're looking for into the form's fields (Filter by Form)">
            🔍 Find
          </button>
          {sort && (
            <button className="rn-sort" onClick={() => sortBy(null)} title="Remove the sort">
              {sort.field} {sort.dir === "ASC" ? "▲" : "▼"} ✕
            </button>
          )}
          {!table && <span className="rn-filter">Read-only (query)</span>}
        </div>
      )}
    </div>
  );
}

const FIND_EXAMPLES: Record<string, string> = {
  ShortText: "e.g. Smith, S*, =Smith",
  LongText: "e.g. a word it contains",
  Number: "e.g. 5, >10, 10...20",
  AutoNumber: "e.g. 5, >10, 10...20",
  Currency: "e.g. >100, 50...200",
  DateTime: "e.g. 3/1/2026, 1/1/2026...3/31/2026",
};

/** A bound control in Find mode: an empty box to type what to look for in its field. */
function FindField(props: {
  c: FormControl;
  inputId: string;
  field?: Field;
  finding: { requests: FindRequest[]; active: number; message?: string };
  setFinding: (f: { requests: FindRequest[]; active: number; message?: string }) => void;
  options?: ChoiceOption[];
  onEnter: () => void;
}) {
  const { c, field, finding } = props;
  const name = c.field;
  const value = name ? (finding.requests[finding.active]?.[name] ?? "") : "";
  const set = (v: string) => {
    if (!name) return;
    const requests = finding.requests.map((r, i) => (i === finding.active ? { ...r, [name]: v } : r));
    props.setFinding({ ...finding, requests, message: undefined });
  };
  const label = c.label ?? c.field ?? "";
  const pos = c.labelPos ?? "top";
  let input: ReactNode;
  if (!name || field?.type === "Image") {
    input = <div className="fc-input readonly fc-muted find-na">—</div>;
  } else if (c.type === "checkbox" || field?.type === "YesNo") {
    input = (
      <select id={props.inputId} className="fc-input find-input" value={value} onChange={(e) => set(e.target.value)} aria-label={`Find ${label}`}>
        <option value="">(any)</option>
        <option value="Yes">Yes</option>
        <option value="No">No</option>
      </select>
    );
  } else {
    const listId = props.options?.length ? `${props.inputId}-choices` : undefined;
    input = (
      <>
        <input
          id={props.inputId}
          className="fc-input find-input"
          value={value}
          list={listId}
          placeholder={FIND_EXAMPLES[field?.type ?? "ShortText"] ?? ""}
          aria-label={`Find ${label}`}
          autoComplete="off"
          onChange={(e) => set(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              props.onEnter();
            }
          }}
        />
        {listId && (
          <datalist id={listId}>
            {props.options!.map((o) => (
              <option key={o.value} value={o.label} />
            ))}
          </datalist>
        )}
      </>
    );
  }
  if (c.type === "checkbox") {
    // One line, like the check box itself: its caption, then Any / Yes / No.
    return (
      <div className="find-check">
        <label htmlFor={props.inputId}>{c.caption ?? label}</label>
        {input}
      </div>
    );
  }
  return (
    <div className={`fc-bound ${pos === "left" ? "left" : ""}`}>
      {pos !== "none" && (
        <label className="fc-caption" htmlFor={props.inputId} style={pos === "left" ? { width: c.labelWidth ?? 110, flex: "none" } : undefined}>
          {label}
        </label>
      )}
      <div className="fc-input-wrap">{input}</div>
    </div>
  );
}

/** The bar above the form in Find mode: what to type, the Look for / Or requests, and Find. */
function FindBar(props: {
  finding: { requests: FindRequest[]; active: number; message?: string };
  setFinding: (f: { requests: FindRequest[]; active: number; message?: string } | null) => void;
  onFind: () => void;
  onCancel: () => void;
}) {
  const { finding } = props;
  const filled = (r: FindRequest) => Object.values(r).some((v) => v.trim());
  return (
    <div className="find-bar" role="region" aria-label="Find records">
      <div className="find-head">
        <strong>🔍 Find records</strong>
        <span className="find-help">
          Type what you're looking for in any field, then press <kbd>Enter</kbd>. Text finds anything containing it;{" "}
          <code>=Smith</code> exact, <code>S*</code> starts with, <code>&gt;100</code>, <code>1/1/2026...3/31/2026</code> from–to, <code>=</code> empty.
        </span>
      </div>
      <div className="find-tabs" role="tablist" aria-label="Find requests">
        {finding.requests.map((r, i) => (
          <button
            key={i}
            role="tab"
            aria-selected={i === finding.active}
            className={`find-tab ${i === finding.active ? "active" : ""} ${filled(r) ? "filled" : ""}`}
            onClick={() => props.setFinding({ ...finding, active: i, message: undefined })}
            title={i === 0 ? "Records matching everything typed here" : "…or records matching everything typed on this tab"}
          >
            {i === 0 ? "Look for" : "Or"}
          </button>
        ))}
        <button
          className="find-tab add"
          onClick={() => props.setFinding({ requests: [...finding.requests, {}], active: finding.requests.length, message: undefined })}
          title="Add another set of criteria; records matching either are found"
        >
          + Or
        </button>
        {finding.requests.length > 1 && (
          <button
            className="find-tab remove"
            onClick={() => {
              const requests = finding.requests.filter((_, i) => i !== finding.active);
              props.setFinding({ requests, active: Math.max(0, finding.active - 1), message: undefined });
            }}
            title="Remove this set of criteria"
          >
            Remove
          </button>
        )}
        <span className="spacer" />
        <button className="primary" onClick={props.onFind}>
          Find
        </button>
        <button onClick={() => props.setFinding({ requests: [{}], active: 0, message: undefined })}>Clear</button>
        <button onClick={props.onCancel}>Cancel</button>
      </div>
      {finding.message && (
        <div className="find-message" role="alert">
          {finding.message}
        </div>
      )}
    </div>
  );
}
