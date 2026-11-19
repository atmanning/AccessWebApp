/** Form View: the designed form, bound to one record at a time. */
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { CellValue, Field, FormControl, FormDef, FormViewMode, ProjectDoc } from "../../../shared/model";
import { readSource } from "../engine/engine";
import { formatValue } from "../engine/values";
import { compileCriteria } from "../engine/findCriteria";
import { isExpression, truthy, type ExprValue } from "../engine/expr";
import type { ControlEvent, FormEvent } from "../../../shared/macros";
import { useMacroRunner } from "../macros/useMacroRunner";
import { formSession, registerForm, registerSubform, type FormHandle } from "../macros/runtime";
import { makeFormCalc } from "./formCalc";
import { SubformView } from "./subform";
import { useLayout } from "../ui/layout";
import { useSource } from "../views/FormReportViews";
import { useCommands, useWorkspace, type OpenArgs, type RecordTarget } from "../workspace/context";
import { useFormEditor } from "./formEditor";
import { Datasheet, type DatasheetColumn } from "../views/Datasheet";
import { FormControlView, type ChoiceOption } from "./FormControls";
import { phoneRows } from "./phoneLayout";
import { isBound, layoutOf, onShownPage, paintOrder, parseValueList, readingOrder, tabSequence, themeStyle } from "./formLayout";

/** Choices for combo and list boxes, by control id. Table and query row sources are read once per change. */
export function useRowSources(doc: ProjectDoc, controls: FormControl[], form?: { name: string; value: (name: string) => ExprValue | undefined }) {
  const lists = controls.filter((c) => c.type === "combobox" || c.type === "listbox");
  const lookups = lists.filter((c) => (c.rowSourceType === "table" || c.rowSourceType === "query") && c.rowSource);
  // Row sources can use the form's values (Form![ID], [Application].[CurrentObjectName]): read them again when those change.
  const formRefs = new Set<string>();
  for (const c of lookups) {
    const sql = c.rowSourceType === "query" ? (doc.queries.find((q) => q.id === c.rowSource)?.sql ?? "") : "";
    for (const m of sql.matchAll(/\[?\b(?:Form|Me)\]?!\[?([^\]\s,()]+)\]?/gi)) formRefs.add(m[1]);
  }
  const formValues = form ? [...formRefs].map((n) => `${n}=${String(form.value(n) ?? "")}`).join(",") : "";
  const key =
    lookups.map((c) => `${c.id}:${c.rowSourceType}:${c.rowSource}:${c.boundColumn ?? ""}:${c.displayColumn ?? ""}`).join("|") + `|${form?.name ?? ""}|${formValues}`;
  const formRef = useRef(form);
  formRef.current = form;
  const [loaded, setLoaded] = useState<Record<string, ChoiceOption[]>>({});
  const sourceDeps = lookups.map((c) => (c.rowSourceType === "table" ? doc.tables.find((t) => t.id === c.rowSource) : doc.queries.find((q) => q.id === c.rowSource)));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: Record<string, ChoiceOption[]> = {};
      for (const c of lookups) {
        try {
          const f = formRef.current;
          const refs = f ? { formName: f.name, form: (n: string) => formRef.current?.value(n) } : undefined;
          const data = await readSource(doc, { kind: c.rowSourceType as "table" | "query", id: c.rowSource! }, refs ? { refs } : {});
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

/** What macros change on a control while the form is open (SetProperty). */
type Override = { hidden?: boolean; locked?: boolean; disabled?: boolean; caption?: string; color?: string; backColor?: string; bold?: boolean };

/** A color from SetProperty: "#rrggbb", or Access's number (blue·65536 + green·256 + red). */
function colorOf(v: ExprValue): string | undefined {
  if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim())) return v.trim();
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const hex = (x: number) => (x & 255).toString(16).padStart(2, "0");
  return `#${hex(n)}${hex(n >> 8)}${hex(n >> 16)}`;
}

/** A form shown in a subform control: only the records linked to the main form's record. */
export interface EmbeddedLink {
  /** Link Master Fields / Link Child Fields (both, or neither for all records). */
  master?: string;
  child?: string;
  /** The main form's value of Link Master Fields (undefined: its record is new). */
  value: CellValue | undefined;
  parentNew: boolean;
  readOnly?: boolean;
  /** How many forms deep (a subform's subform…), to stop a form showing itself forever. */
  depth: number;
  /** The subform control's name, so the main form can read its controls ([Tasks subform]![Total]). */
  alias?: string;
  /** Called when its records change, so the main form works out [Tasks subform]![Total] again. */
  onData?: () => void;
}

/** One record as shown: the current one, or one row of a continuous form. */
type Rec = { row: CellValue[] | null; rowIndex: number | undefined; isNew: boolean; p: number };

const sameKey = (a: CellValue | undefined, b: CellValue | undefined) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

export function FormRunView({ form, tabKey, goto, open, embedded }: { form: FormDef; tabKey: string; goto?: RecordTarget; open?: OpenArgs; embedded?: EmbeddedLink }) {
  const ws = useWorkspace();
  const runMacro = useMacroRunner();
  // Kept while the tab is open, so switching tabs doesn't reset the form (see formSession).
  const session = useMemo(() => formSession(tabKey), [tabKey]);
  const saved = session.state as Partial<{
    pos: number;
    filter: Record<string, string>[] | null;
    filterOn: boolean;
    sort: { field: string; dir: "ASC" | "DESC" } | null;
    unbound: Record<string, CellValue>;
    where: string | null;
    overrides: Record<string, Override>;
    readOnlyMode: boolean;
    tabPages: Record<string, number>;
  }>;
  const { compact, touch } = useLayout();
  const { data, error, table } = useSource(form.source, { editable: true });
  const editor = useFormEditor(data, table);
  /** Position in the found (filtered and sorted) records. */
  const [pos, setPos] = useState(saved.pos ?? 0);
  const [isNew, setIsNew] = useState(false);
  const [fieldError, setFieldError] = useState<{ id: string; msg: string } | null>(null);

  // ---- Find mode (Filter by Form): type criteria into the form's own fields ----
  const [finding, setFinding] = useState<{ requests: FindRequest[]; active: number; message?: string } | null>(null);
  const [filter, setFilter] = useState<FindRequest[] | null>(saved.filter ?? null);
  const [filterOn, setFilterOn] = useState(saved.filterOn ?? false);
  // Records added or edited while filtered stay in view until the filter is applied again, as in Access.
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ field: string; dir: "ASC" | "DESC" } | null>(saved.sort ?? null);
  const [focusField, setFocusField] = useState<string | null>(null);
  /** The key of a record just added (or opened by link), to go to once it's in the data. */
  const [addedKey, setAddedKey] = useState<string | null>(null);
  /** Continuous forms show this many records, then "Show more". */
  const [limit, setLimit] = useState(100);
  // Unbound controls (no Control Source) hold what's typed while the form is open, as in Access.
  const [unbound, setUnbound] = useState<Record<string, CellValue>>(saved.unbound ?? {});
  // Set by macros: a Where Condition (OpenForm, ApplyFilter), control properties, Data Mode Read Only.
  const [where, setWhere] = useState<string | null>("where" in saved ? saved.where! : (open?.where ?? null));
  const [overrides, setOverrides] = useState<Record<string, Override>>(saved.overrides ?? {});
  const [readOnlyMode, setReadOnlyMode] = useState(saved.readOnlyMode ?? /read\s*only/i.test(open?.dataMode ?? ""));
  // Each tab control's selected page.
  const [tabPages, setTabPages] = useState<Record<string, number>>(saved.tabPages ?? {});
  session.state = { pos, filter, filterOn, sort, unbound, where, overrides, readOnlyMode, tabPages };

  const fieldList = useMemo(() => (data ? data.columns.map((name, i) => ({ name, field: data.fields[i] })) : []), [data]);
  const designed = useMemo(() => layoutOf(form, fieldList), [form, fieldList]);
  // The layout with what macros changed (SetProperty Visible, Enabled, Caption…).
  const layout = useMemo(
    () =>
      Object.keys(overrides).length
        ? { ...designed, controls: designed.controls.map((c) => (overrides[c.id] ? { ...c, ...overrides[c.id], ...(overrides[c.id].disabled ? { locked: true } : {}) } : c)) }
        : designed,
    [designed, overrides],
  );
  // Phones get the form in one column, unless it's set to keep its designed layout.
  const phone = compact && layout.phoneLayout !== "original";
  // Tablets (and phones keeping the layout): a form wider than the screen shrinks to fit it.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [fit, setFit] = useState(1);
  const [phoneView, setPhoneView] = useState<"list" | "record">("list");
  useEffect(() => {
    if (!scrollEl || phone || embedded || !(touch || compact)) {
      setFit(1);
      return;
    }
    const measure = () => {
      const pad = parseFloat(getComputedStyle(scrollEl).paddingLeft) + parseFloat(getComputedStyle(scrollEl).paddingRight);
      const avail = scrollEl.clientWidth - pad - 2;
      setFit(avail > 0 && avail < layout.width ? Math.max(0.45, Math.floor((avail / layout.width) * 1000) / 1000) : 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scrollEl);
    return () => ro.disconnect();
  }, [scrollEl, phone, embedded, touch, compact, layout.width]);
  // The form's own handle (set below), which macros and row sources read values through.
  const hostRef = useRef<Host | null>(null);
  const options = useRowSources(ws.doc, layout.controls, { name: form.name, value: (n) => hostRef.current?.value(n) });
  // A subform adds records for the main form's record, so not before that one is saved.
  const linkBlocked = !!embedded?.child && (embedded.parentNew || embedded.value === undefined || embedded.value === null || embedded.value === "");
  const canAdd = editor.canAdd && !ws.readOnly && !readOnlyMode && !embedded?.readOnly && !linkBlocked && layout.allowAdditions !== false;
  const canDelete = editor.canDelete && !ws.readOnly && !readOnlyMode && !embedded?.readOnly && layout.allowDeletions !== false;
  /** Unbound controls' values by control name, for expressions ([txtSearch]). */
  const unboundVars = useMemo(() => {
    const out: Record<string, ExprValue> = {};
    for (const c of designed.controls) {
      if (c.field || !(c.type === "textbox" || c.type === "combobox" || c.type === "listbox" || c.type === "checkbox")) continue;
      out[c.name] = c.id in unbound ? (unbound[c.id] as ExprValue) : c.type === "checkbox" ? false : null;
    }
    // The form's properties expressions read: [RecordSource], [Form].[FilterOn]…
    const src = form.source;
    out.RecordSource ??= (src?.kind === "table" ? ws.doc.tables.find((t) => t.id === src.id)?.name : src ? ws.doc.queries.find((q) => q.id === src.id)?.name : undefined) ?? "";
    out.FilterOn ??= !!where || filterOn;
    out.Filter ??= where ?? "";
    return out;
  }, [designed.controls, unbound, form.source, ws.doc.tables, ws.doc.queries, where, filterOn]);
  const calc = useMemo(() => (data ? makeFormCalc(ws.doc, layout, data.columns) : null), [ws.doc, layout, data]);

  const colOf = (name: string) => (data ? data.columns.findIndex((c) => c.toLowerCase() === name.toLowerCase()) : -1);
  const keyOf = editor.keyOf;
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
    if (embedded?.child) {
      const ci = colOf(embedded.child);
      idx = ci < 0 ? [] : idx.filter((i) => sameKey(data.rows[i][ci], embedded.value));
    }
    if (where && calc) {
      try {
        idx = idx.filter((i) => kept.has(keyOf(i)) || truthy(calc.evaluate(where, data.rows[i], () => [], unboundVars)));
      } catch (e) {
        ws.setStatus(`The filter ${where} can't be worked out: ${(e as Error).message}`, "error");
      }
    }
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
  }, [data, filter, filterOn, kept, sort, shownBy, where, calc, embedded?.value, embedded?.child]); // eslint-disable-line react-hooks/exhaustive-deps
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
    if (addedKey === null || !data) return;
    const i = data.rows.findIndex((_, r) => keyOf(r) === addedKey);
    if (i < 0) return;
    if (filterOn || where) setKept((k) => new Set(k).add(addedKey));
    const p = order.indexOf(i);
    if (p >= 0) {
      setPos(p);
      setAddedKey(null);
    }
  }, [data, order, addedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opened at one record (a label's QR code): find it by its key and show it, even if filtered out.
  useEffect(() => {
    if (!goto || !data) return;
    const ci = colOf(goto.field);
    const i = ci < 0 ? -1 : data.rows.findIndex((r) => String(r[ci] ?? "") === goto.value);
    if (i < 0) return ws.setStatus(`There's no record with ${goto.field} ${goto.value} any more.`, "error");
    setFinding(null);
    setIsNew(false);
    setAddedKey(keyOf(i));
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
    if (!editor.canAdd) return ws.setStatus("New records can't be added through this form's query (it joins several tables, or can't be edited). Add them in the table.", "error");
    if (linkBlocked) return ws.setStatus("Fill in the main form's record first.", "error");
    if (!canAdd) return ws.setStatus("This form doesn't allow new records.", "error");
    (document.activeElement as HTMLElement | null)?.blur?.();
    setFieldError(null);
    setIsNew(true);
  };
  const deleteRecord = async () => {
    if (finding) return;
    if (!canDelete) return ws.setStatus(editor.canDelete ? "This form doesn't allow deleting records." : "Records can't be deleted through this form's query. Delete them in the table.", "error");
    if (isNew) return go(count - 1);
    if (!count) return;
    if (await editor.deleteRows([order[pos]])) setPos((p) => Math.max(0, Math.min(p, count - 2)));
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
    if (where) {
      setWhere(null);
      setKept(new Set());
      setPos(0);
      return ws.setStatus("Showing all records.");
    }
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

  useCommands(tabKey, {
    newRecord: goNew,
    deleteRecord,
    find: startFind,
    filterByForm: startFind,
    toggleFilter,
    filterOn: !!finding || filterOn || !!where,
    sortAsc: () => sortBy("ASC"),
    sortDesc: () => sortBy("DESC"),
    removeSort: () => sortBy(null),
  });

  // ---- Macros: what they can do to this form, and the form's events ----
  type Host = Omit<FormHandle, "formId" | "name" | "tabKey">;
  const handle = useMemo<FormHandle>(() => {
    const call =
      <K extends keyof Host>(k: K) =>
      (...a: Parameters<Host[K]>) => {
        const h = hostRef.current;
        if (!h) throw new Error(`The form '${form.name}' is still opening.`);
        return (h[k] as (...x: unknown[]) => ReturnType<Host[K]>)(...a);
      };
    return {
      formId: form.id,
      name: form.name,
      tabKey,
      value: call("value"),
      property: call("property"),
      evaluate: call("evaluate"),
      goToRecord: call("goToRecord"),
      goToControl: call("goToControl"),
      newRecord: call("newRecord"),
      saveRecord: call("saveRecord"),
      deleteRecord: call("deleteRecord"),
      undo: call("undo"),
      requery: call("requery"),
      applyFilter: call("applyFilter"),
      findRecord: call("findRecord"),
      setValue: call("setValue"),
      setProperty: call("setProperty"),
      close: call("close"),
    };
  }, [form.id, form.name, tabKey]);
  // Registered until the tab closes (endFormSession), so [Forms]![Name]![Control] works from other tabs too.
  useEffect(() => {
    session.unregister?.();
    const off = registerForm(handle);
    const offSub = embedded?.alias ? registerSubform(embedded.alias, handle) : undefined;
    session.unregister = () => (off(), offSub?.());
  }, [handle]); // eslint-disable-line react-hooks/exhaustive-deps
  const formRef = useRef(form);
  formRef.current = form;
  const fireForm = (e: FormEvent) => {
    const steps = formRef.current.events?.[e];
    // Form events run on their own, so a failure goes to the status bar, not a message box.
    if (steps?.length) void runMacro(steps, handle, { quiet: true });
  };
  const fireControl = (c: FormControl, e: ControlEvent) => {
    const steps = c.events?.[e];
    if (!steps?.length) return false;
    void runMacro(steps, handle, { quiet: e === "afterUpdate", activeControl: c.name });
    return true;
  };
  const loaded = !!data && !!calc;
  // Opened by a macro: only the records matching its Where Condition, at a new record for Data Mode Add.
  useEffect(() => {
    if (!open || !loaded || session.appliedOpen === open.n) return;
    session.appliedOpen = open.n;
    setWhere(open.where ?? null);
    setKept(new Set());
    setReadOnlyMode(/read\s*only/i.test(open.dataMode ?? ""));
    if (/add/i.test(open.dataMode ?? "") && canAdd) setIsNew(true);
    else {
      setIsNew(false);
      setPos(0);
    }
  }, [open?.n, loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!loaded || session.loaded) return;
    session.loaded = true;
    fireForm("onLoad");
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  const currentKey = isNew ? "new" : String(order[pos] ?? "");
  useEffect(() => {
    if (!loaded || finding || session.lastCurrent === currentKey) return;
    session.lastCurrent = currentKey;
    fireForm("onCurrent");
  }, [loaded, currentKey]); // eslint-disable-line react-hooks/exhaustive-deps
  session.onClose = () => fireForm("onClose");
  // A subform tells the main form when its records change (totals the main form shows from it).
  useEffect(() => {
    if (loaded) embedded?.onData?.();
  }, [loaded, order]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, setSubformTick] = useState(0);

  if (error) return <div className="query-error"><strong>This form can't open.</strong><p>{error}</p></div>;
  if (!data) return <div className="empty-view">Loading…</div>;

  const colIdx = colOf;
  const rowIndex = order[pos];
  const row = isNew || rowIndex === undefined ? null : data.rows[rowIndex];
  /** The records the form shows (for Sum, Count… in calculated controls). */
  const foundRows = () => order.map((i) => data.rows[i]);

  const cur: Rec = { row, rowIndex, isNew, p: pos };
  /** Saves a field of a record (a new record is added by its first field); returns the error, if any. */
  const commitAt = (rec: Rec, col: number, input: string | boolean): string | null => {
    const preset = embedded?.child ? { [embedded.child]: embedded.value ?? null } : undefined;
    const err = editor.commit(rec.isNew ? "new" : rec.rowIndex!, col, input, preset);
    if (err) return err;
    if (rec.isNew) {
      setIsNew(false);
      setAddedKey(editor.lastAddedKey()); // go to the record that was just added
    } else if (filterOn || where) setKept((k) => new Set(k).add(keyOf(rec.rowIndex!)));
    return null;
  };
  const save = (c: FormControl, col: number, input: string | boolean, rec: Rec = cur) => {
    const err = commitAt(rec, col, input);
    if (err) {
      setFieldError({ id: c.id, msg: err });
      ws.setStatus(err, "error");
      return;
    }
    setFieldError(null);
    fireControl(c, "afterUpdate");
  };

  const controlByName = (name: string) => designed.controls.find((c) => c.name.toLowerCase() === name.toLowerCase());
  const exprRow = row;
  hostRef.current = {
    value: (name) => {
      const c = controlByName(name);
      if (/^newrecord$/i.test(name) && !c) return isNew;
      if (/^dirty$/i.test(name) && !c) return false;
      if (/^filteron$/i.test(name) && !c) return !!where || filterOn;
      if (/^filter$/i.test(name) && !c) return where ?? "";
      if (/^orderby$/i.test(name) && !c) return sort ? `[${sort.field}]${sort.dir === "DESC" ? " DESC" : ""}` : "";
      if (/^orderbyon$/i.test(name) && !c) return !!sort;
      if (/^name$/i.test(name) && !c && colIdx(name) < 0) return form.name;
      if (c?.type === "tab") return tabPages[c.id] ?? 0;
      if (c && !c.field) return c.id in unbound ? (unbound[c.id] as ExprValue) : c.type === "checkbox" ? false : null;
      if (c?.field && isExpression(c.field)) return calc!.value(c, exprRow, foundRows, unboundVars).value;
      const i = colIdx(c?.field ?? name);
      if (i < 0) return undefined;
      return exprRow ? (exprRow[i] as ExprValue) : null;
    },
    // [NewRecord] and [Dirty] stand for Me.NewRecord / Me.Dirty in macros translated from VBA.
    evaluate: (e) => makeFormCalc(ws.getDoc(), layout, data.columns).evaluate(e, exprRow, foundRows, { NewRecord: isNew, Dirty: false, FilterOn: !!where || filterOn, Filter: where ?? "", ...unboundVars }),
    goToRecord: (record, offset) => {
      const r = record.toLowerCase().replace(/\s+/g, "");
      const to = (n: number) => {
        if (n < 0 || n > count - 1) throw new Error("You can't go to the specified record (you may be at the end of the records).");
        go(n);
      };
      if (r === "first") return to(0);
      if (r === "last") return to(count - 1);
      if (r === "next") return isNew ? to(count) : to(pos + offset);
      if (r === "previous") return to(isNew ? count - offset : pos - offset);
      if (r === "goto") return to(offset - 1);
      if (r === "new" || r === "newrec") return goNew();
      throw new Error(`'${record}' isn't a Record choice (Next, Previous, First, Last, Go To or New).`);
    },
    goToControl: (name) => {
      const c = controlByName(name);
      // A control on another page of a tab control: show that page first.
      if (c?.onPage) {
        const on = c.onPage;
        setTabPages((t) => ({ ...t, [on.tab]: on.index }));
      }
      // After a message box closes (it gives the focus back to the button first), and the page shows.
      setTimeout(() => {
        const box = c && rootRef.current?.querySelector<HTMLElement>(`[data-ctl="${c.id}"]`);
        box?.querySelector<HTMLElement>("input, select, textarea, button, [tabindex]")?.focus();
      }, 30);
      if (c?.field) setFocusField(c.field);
      return !!c;
    },
    newRecord: goNew,
    saveRecord: () => (document.activeElement as HTMLElement | null)?.blur?.(),
    deleteRecord,
    undo: () => (document.activeElement as HTMLElement | null)?.blur?.(),
    requery: () => setKept(new Set()),
    applyFilter: (w) => {
      setWhere(w);
      setKept(new Set());
      if (w === null) setFilterOn(false);
      setIsNew(false);
      setPos(0);
    },
    findRecord: (text, match) => {
      const needle = text.toLowerCase();
      const fieldsShown = designed.controls.filter((c) => c.field && !isExpression(c.field) && isBound(c.type)).map((c) => colIdx(c.field!)).filter((i) => i >= 0);
      const hit = (r: CellValue[]) =>
        fieldsShown.some((i) => {
          const v = r[i] === null || r[i] === undefined ? "" : String(r[i]).toLowerCase();
          return /any/i.test(match) ? v.includes(needle) : /start/i.test(match) ? v.startsWith(needle) : v === needle;
        });
      for (let k = 1; k <= count; k++) {
        const p = (pos + k) % count;
        if (hit(data.rows[order[p]])) {
          go(p);
          return true;
        }
      }
      return false;
    },
    setValue: (name, v) => {
      const c = controlByName(name);
      // The form's own Filter / Order By, as Access templates set them from macros.
      if (!c && /^(filter|filteron|orderby|orderbyon)$/i.test(name)) {
        const k = name.toLowerCase();
        const text = v === null ? "" : String(v).trim();
        if (k === "filter") setWhere(text || null);
        else if (k === "filteron" && !truthy(v)) (setWhere(null), setFilterOn(false));
        else if (k === "orderby") {
          const m = /^\[?([^\],]+?)\]?(?:\s+(ASC|DESC))?(?:,|$)/i.exec(text.replace(/^\[[^\]]+\]\./, ""));
          setSort(m ? { field: m[1], dir: m[2]?.toUpperCase() === "DESC" ? "DESC" : "ASC" } : null);
        } else if (k === "orderbyon" && !truthy(v)) setSort(null);
        setKept(new Set());
        setPos(0);
        return null;
      }
      if (c?.type === "tab") {
        setTabPages((t) => ({ ...t, [c.id]: Math.max(0, Math.min((c.pages?.length ?? 1) - 1, Number(v) || 0)) }));
        return null;
      }
      if (c && !c.field) {
        setUnbound((u) => ({ ...u, [c.id]: v as CellValue }));
        return null;
      }
      if (c?.field && isExpression(c.field)) return `${c.name} is calculated (=…), so it can't be set.`;
      const i = colIdx(c?.field ?? name);
      if (i < 0) return `There's no control or field named '${name}' on ${form.name}.`;
      if (ws.readOnly || readOnlyMode) return "This form's records can't be changed.";
      return editor.readOnlyReason(i) ?? commitAt(cur, i, typeof v === "boolean" ? v : v === null ? "" : String(v));
    },
    property: (name, property) => {
      const c = controlByName(name);
      if (!c) return undefined;
      const o = { ...c, ...overrides[c.id] };
      switch (property.toLowerCase()) {
        case "visible": return !o.hidden;
        case "enabled": return !o.disabled;
        case "locked": return !!o.locked;
        case "caption": return o.caption ?? "";
        case "name": return c.name;
        case "value": return hostRef.current!.value(name) ?? null;
      }
      return undefined;
    },
    setProperty: (name, property, v) => {
      const c = controlByName(name);
      if (!c) return `There's no control named '${name}' on ${form.name}.`;
      const yes = typeof v === "string" ? /^(true|yes|on|-1|1)$/i.test(v.trim()) : truthy(v);
      const set = (o: Override) => setOverrides((all) => ({ ...all, [c.id]: { ...all[c.id], ...o } }));
      switch (property.toLowerCase()) {
        case "visible": return set({ hidden: !yes }), null;
        case "enabled": return set({ disabled: !yes }), null;
        case "locked": return set({ locked: yes }), null;
        case "caption": return set({ caption: v === null ? "" : String(v) }), null;
        case "forecolor": return set({ color: colorOf(v) }), null;
        case "backcolor": return set({ backColor: colorOf(v) }), null;
        case "fontbold": return set({ bold: yes }), null;
        case "value": return hostRef.current!.setValue(name, v);
      }
      return `The property '${property}' can't be set here (Visible, Enabled, Locked, Caption, ForeColor, BackColor, FontBold or Value).`;
    },
    close: () => ws.closeTab(tabKey),
  };

  const act = (c: FormControl) => {
    if (fireControl(c, "onClick")) return;
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
    if (overrides[c.id]?.disabled) return true;
    if (c.events?.onClick?.length) return false;
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

  const renderControl = (c: FormControl, rec: Rec = cur) => {
    if (c.hidden) return null;
    if (c.type === "tab") return <FormControlView c={c} page={tabPages[c.id] ?? 0} onPage={(i) => setTabPages((t) => ({ ...t, [c.id]: i }))} />;
    const { row, isNew } = rec;
    const inputId = rec === cur ? `fv-${form.id}-${c.id}` : `fv-${form.id}-${c.id}-${rec.isNew ? "new" : rec.p}`;
    if (c.type === "subform") {
      // Related records of this record (Link Child Fields = this record's Link Master Fields).
      const mi = c.linkMaster ? colIdx(c.linkMaster) : -1;
      const master = c.linkMaster ? (row && mi >= 0 ? row[mi] : undefined) : null;
      const sub = c.sourceForm ? ws.doc.forms.find((f) => f.id === c.sourceForm) : undefined;
      const content = finding ? (
        <div className="sf-box sf-message">Related records aren't searched in Find.</div>
      ) : c.sourceForm ? (
        !sub ? (
          <div className="sf-box sf-message">The form this subform showed was deleted. Choose another in the Property Sheet.</div>
        ) : sub.id === form.id || (embedded?.depth ?? 0) >= 3 ? (
          <div className="sf-box sf-message">A form can't show itself as a subform.</div>
        ) : !!c.linkMaster && mi < 0 ? (
          <div className="sf-box sf-message">The form's records have no field named {c.linkMaster}. Check Link Master Fields in the Property Sheet.</div>
        ) : (
          <div className="sf-box sf-form">
            <FormRunView
              form={sub}
              tabKey={`${tabKey}|sf:${c.id}`}
              embedded={{ master: c.linkMaster, child: c.linkChild, value: master ?? undefined, parentNew: isNew, readOnly: layout.allowEdits === false || readOnlyMode, depth: (embedded?.depth ?? 0) + 1, alias: c.name, onData: () => setSubformTick((n) => n + 1) }}
            />
          </div>
        )
      ) : (
        <SubformView c={c} master={master} newRecord={isNew} masterMissing={!!c.linkMaster && mi < 0} readOnly={layout.allowEdits === false} />
      );
      return <FormControlView c={c} inputId={inputId} run={{ value: null, readOnly: true, isNew, content, onCommit: () => {}, onAction: () => {} }} />;
    }
    if (isExpression(c.field)) {
      // Calculated: worked out from the record; nothing to type (or search) here.
      const r = finding ? { text: "", value: null } : calc ? calc.value(c, row, foundRows, unboundVars) : { text: "", value: null };
      return <FormControlView c={c} inputId={inputId} run={{ value: null, readOnly: true, isNew, display: { text: r.text, error: "error" in r ? r.error : undefined, numeric: typeof r.value === "number" }, onCommit: () => {}, onAction: () => {} }} />;
    }
    if (finding && isBound(c.type)) return <FindField c={c} inputId={inputId} field={c.field ? data.fields[colIdx(c.field)] : undefined} finding={finding} setFinding={setFinding} options={options[c.id]} onEnter={runFind} />;
    if (!isBound(c.type)) return <FormControlView c={c} inputId={inputId} run={{ value: null, readOnly: true, isNew, onCommit: () => {}, onAction: () => act(c), buttonDisabled: !!finding || buttonDisabled(c), imageUrl: (imageId: string) => ws.imageUrl(imageId) }} />;
    if (!c.field && (c.type === "textbox" || c.type === "combobox" || c.type === "listbox" || c.type === "checkbox")) {
      const kind = c.type === "checkbox" ? "YesNo" : "ShortText";
      return (
        <FormControlView
          c={c}
          inputId={inputId}
          run={{
            value: unbound[c.id] ?? (kind === "YesNo" ? false : null),
            field: { id: c.id, name: c.name, type: kind, required: false } as Field,
            readOnly: !!c.locked,
            isNew,
            options: options[c.id],
            onCommit: (input) => {
              setUnbound((u) => ({ ...u, [c.id]: kind === "YesNo" ? input === true || input === "true" || input === "Yes" : input === "" ? null : (input as CellValue) }));
              // After Update sees the new value once it's in place.
              setTimeout(() => fireControl(c, "afterUpdate"), 0);
            },
            onAction: () => {},
          }}
        />
      );
    }
    const i = c.field ? colIdx(c.field) : -1;
    const field = i >= 0 ? data.fields[i] : undefined;
    // An image control with its own picture (a logo) shows that.
    const value: CellValue = c.type === "image" && !c.field ? (c.picture ?? null) : row && i >= 0 ? row[i] : null;
    const readOnly =
      ws.readOnly ||
      readOnlyMode ||
      !!embedded?.readOnly ||
      !field ||
      editor.readOnlyReason(i) !== null ||
      field.type === "AutoNumber" ||
      !!c.locked ||
      (!isNew && layout.allowEdits === false) ||
      (isNew && !canAdd);
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
          onCommit: (input) => field && save(c, i, input, rec),
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
    // Buttons with On Got Focus too: a search box's Enter goes to its Go button, which runs the search.
    const items = [...root.querySelectorAll<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea, [role=listbox][tabindex='0'], [data-gotfocus] button:not([disabled])")].filter(
      (el) => el === t || (el.tabIndex >= 0 && el.offsetParent !== null),
    );
    const i = items.indexOf(t);
    if (i < 0) return;
    e.preventDefault();
    const next = items[i + (e.shiftKey ? -1 : 1)];
    if (next) next.focus();
    else t.blur();
  };

  // Remount a control when its record or value changes (undo, another control), so it shows the saved value.
  const valueKey = (c: FormControl, rec: Rec = cur) => {
    if (finding) return `${c.id}-find-${finding.active}`;
    const i = c.field ? colIdx(c.field) : -1;
    const k = rec === cur ? recordKey : rec.isNew ? "new" : keyOf(rec.rowIndex!);
    return `${c.id}-${k}-${rec.row && i >= 0 ? String(rec.row[i]) : ""}`;
  };
  const recordKey = isNew ? "new" : `${pos}`;
  // Default View: Find always uses one record (the form's own fields hold the criteria).
  const designMode: FormViewMode = finding ? "single" : (layout.defaultView ?? "single");
  // Phones: a list form (continuous, datasheet, split) is a list of cards; tapping one shows its record.
  const phoneList = phone && !embedded && designMode !== "single";
  const mode: FormViewMode = phoneList ? "single" : designMode;
  const showCards = phoneList && phoneView === "list" && !finding;
  const continuousRecs: Rec[] =
    mode === "continuous"
      ? [...order.slice(0, limit).map((ri, p) => ({ row: data.rows[ri], rowIndex: ri, isNew: false, p })), ...(canAdd ? [{ row: null, rowIndex: undefined, isNew: true, p: -1 }] : [])]
      : [];
  /** Clicking into a record of a continuous form makes it the current record (for macros, Delete…). */
  const selectRec = (rec: Rec) => {
    if (rec.isNew) {
      if (!isNew) setIsNew(true);
    } else if (isNew || rec.p !== pos) {
      setIsNew(false);
      setFieldError(null);
      setPos(rec.p);
    }
  };
  // Datasheet View: the detail section's text boxes, combo boxes and check boxes, in tab order.
  const designedSheet = mode === "datasheet" || mode === "split" ? tabSequence(layout).filter((c) => c.section === "detail" && !c.hidden && (c.type === "textbox" || c.type === "combobox" || c.type === "listbox" || c.type === "checkbox") && !!c.field) : [];
  // A datasheet form with no fields placed shows every column of its record source.
  const sheetControls: FormControl[] =
    designedSheet.length || (mode !== "datasheet" && mode !== "split")
      ? designedSheet
      : data.columns.map((name, i) => ({ id: `col${i}`, type: data.fields[i]?.type === "YesNo" ? "checkbox" : "textbox", name, field: name, section: "detail", x: 0, y: 0, w: 100, h: 20 }));
  const captionOf = (c: FormControl) => {
    // The control's own label, its attached label (just left of it), or the header label above it.
    if (c.label) return c.label;
    const attached = layout.controls.find((l) => l.type === "label" && l.caption && l.section === c.section && Math.abs(l.y - c.y) < 10 && l.x + l.w <= c.x + 6 && c.x - (l.x + l.w) < 48);
    if (attached?.caption) return attached.caption;
    const near = layout.controls.find((l) => l.type === "label" && l.caption && Math.abs(l.x - c.x) < 12 && l.section !== "detail");
    return near?.caption ?? (isExpression(c.field) ? c.name : c.field!);
  };
  const sheetColumns: DatasheetColumn[] = sheetControls.map((c) => {
    const ci = isExpression(c.field) ? -1 : colIdx(c.field!);
    const field = ci >= 0 ? data.fields[ci] : ({ id: c.id, name: c.name, type: c.type === "checkbox" ? "YesNo" : "ShortText", required: false } as Field);
    const reason = ci < 0 ? `${c.name} is calculated, so it can't be edited.` : c.locked ? `${c.name} is locked.` : editor.readOnlyReason(ci);
    const opts = options[c.id];
    return {
      key: c.id,
      label: captionOf(c),
      field,
      readOnly: !!reason,
      readOnlyReason: reason ?? undefined,
      lookup: opts?.length && (c.type === "combobox" || c.type === "listbox") ? { options: opts, limit: true } : undefined,
    };
  });
  const sheetValue = (r: number, col: number): CellValue => {
    const c = sheetControls[col];
    const rowData = data.rows[order[r]];
    if (!c || !rowData) return null;
    if (isExpression(c.field)) return calc ? calc.value(c, rowData, foundRows, unboundVars).text : null;
    const ci = colIdx(c.field!);
    return ci >= 0 ? rowData[ci] : null;
  };
  const sectionHeight = (s: "header" | "detail" | "footer") => layout.sections[s];
  // Desktop: the controls go into the page in tab order, so Tab follows it; phones stack them top to bottom.
  const ordered = phone ? readingOrder(layout.controls) : tabSequence(layout);

  const sectionBody = (s: "header" | "detail" | "footer", rec: Rec = cur) => {
    // Subforms on other pages of a tab control stay (hidden), so totals read from them still work.
    const shown = (c: FormControl) => onShownPage(c, tabPages, layout);
    const list = ordered.filter((c) => c.section === s && !c.hidden && (shown(c) || c.type === "subform"));
    if (!phone) {
      // A picture placed on a button's left (Access templates do this): its caption starts after the picture.
      const pad = new Map<string, number>();
      for (const img of list) {
        if (img.type !== "image" || img.field || !img.picture || img.w > 64) continue;
        for (const b of list) {
          if (b.type !== "button" || b.transparent || !b.caption) continue;
          const ix = Math.max(0, Math.min(img.x + img.w, b.x + b.w) - Math.max(img.x, b.x));
          const iy = Math.max(0, Math.min(img.y + img.h, b.y + b.h) - Math.max(img.y, b.y));
          if (ix * iy >= img.w * img.h * 0.4 && img.x < b.x + b.w / 2) pad.set(b.id, Math.max(pad.get(b.id) ?? 0, img.x + img.w - b.x + 4));
        }
      }
      // Tab controls first, so the controls on their pages draw on top.
      return paintOrder(list).map((c) => (
        <div
          key={valueKey(c, rec)}
          className={`fv-ctl t-${c.type} ${c.tabStop === false ? "no-tab" : ""}`}
          data-field={isExpression(c.field) ? undefined : c.field}
          data-ctl={c.id}
          onDoubleClick={c.events?.onDblClick?.length ? () => fireControl(c, "onDblClick") : undefined}
          onClick={c.type !== "button" && c.events?.onClick?.length && !finding ? () => fireControl(c, "onClick") : undefined}
          data-gotfocus={c.events?.onGotFocus?.length ? "" : undefined} onFocus={c.events?.onGotFocus?.length ? (e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && fireControl(c, "onGotFocus") : undefined} onBlur={c.events?.onLostFocus?.length ? (e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && fireControl(c, "onLostFocus") : undefined}
          style={{ left: c.x, top: c.y, width: c.w, height: c.h, ...(c.transparent ? { zIndex: 1 } : {}), ...(pad.has(c.id) ? ({ "--btn-pad": `${pad.get(c.id)}px` } as object) : {}), ...(shown(c) ? {} : { display: "none" }) }}
        >
          {renderControl(c, rec)}
        </div>
      ));
    }
    // Phone: one column, labels above their boxes, buttons side by side (see phoneLayout.ts).
    const wrap = (c: FormControl) => (
      <div
        key={valueKey(c, rec)}
        className={`fv-ctl flow t-${c.type} ${c.tabStop === false ? "no-tab" : ""} ${c.picture && c.type === "button" && !c.caption ? "icon-only" : ""}`}
        data-field={isExpression(c.field) ? undefined : c.field}
        data-ctl={c.id}
        onDoubleClick={c.events?.onDblClick?.length ? () => fireControl(c, "onDblClick") : undefined}
        onClick={c.type !== "button" && c.events?.onClick?.length && !finding ? () => fireControl(c, "onClick") : undefined}
        data-gotfocus={c.events?.onGotFocus?.length ? "" : undefined}
        onFocus={c.events?.onGotFocus?.length ? (e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && fireControl(c, "onGotFocus") : undefined} onBlur={c.events?.onLostFocus?.length ? (e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && fireControl(c, "onLostFocus") : undefined}
        style={!shown(c) ? { display: "none" } : c.multiline || c.type === "listbox" || c.type === "subform" || (c.type === "image" && !!c.field) ? { minHeight: Math.min(c.h, 320) } : undefined}
      >
        {renderControl(c, rec)}
      </div>
    );
    // A list form's column headings (header labels over the detail's boxes): the cards label their values instead.
    const detail = phoneList && s === "header" ? layout.controls.filter((d) => d.section === "detail" && isBound(d.type)) : [];
    const heading = (c: FormControl) => c.type === "label" && detail.some((d) => Math.abs(d.x - c.x) < 16 || (c.x >= d.x - 4 && c.x + c.w <= d.x + d.w + 4)) && c.y + c.h >= layout.sections.header - 40;
    return phoneRows(detail.length ? list.filter((c) => !heading(c)) : list).map((r) =>
      r.kind === "block" ? (
        wrap(r.item.c)
      ) : (
        <div key={`${r.kind}-${r.items[0].c.id}`} className={r.kind === "buttons" ? `fv-btn-row ${s === "header" ? "toolbar" : ""}` : "fv-inline-row"}>
          {r.items.map((it) => wrap(it.c))}
        </div>
      ),
    );
  };

  // Phone list: each record as a card (its first few fields), and a switch between the list and one record.
  const cardControls: { label: string; field: string; c?: FormControl }[] = (() => {
    const placed = tabSequence(layout).filter((c) => c.section === "detail" && !c.hidden && !c.phoneHidden && (c.type === "textbox" || c.type === "combobox" || c.type === "checkbox") && !!c.field && !isExpression(c.field) && colIdx(c.field) >= 0);
    const list = placed.length ? placed.map((c) => ({ label: captionOf(c), field: c.field!, c })) : data.columns.map((f) => ({ label: f, field: f }));
    // An AutoNumber ID says little: the card leads with the first other field.
    const isId = (f: string) => data.fields[colIdx(f)]?.type === "AutoNumber";
    return [...list.filter((x) => !isId(x.field)), ...list.filter((x) => isId(x.field))].slice(0, 4);
  })();
  const cardText = (x: (typeof cardControls)[number], row: CellValue[]) => {
    const v = row[colIdx(x.field)];
    if (v === null || v === undefined || v === "") return "";
    const opts = x.c ? options[x.c.id] : undefined;
    const hit = opts?.find((o) => o.value === String(v));
    if (hit) return hit.label;
    const f = data.fields[colIdx(x.field)];
    if (f?.type === "YesNo") return v === true || v === 1 ? "Yes" : "No";
    if (f?.type === "Image") return "";
    return formatValue(f, v);
  };
  const phoneCard = (p: number) => {
    const row = data.rows[order[p]];
    const [first, ...rest] = cardControls;
    return {
      key: keyOf(order[p]),
      title: first ? cardText(first, row) || "(blank)" : `Record ${p + 1}`,
      lines: rest.map((x) => ({ label: x.label, text: cardText(x, row) })).filter((l) => l.text),
    };
  };
  const phoneSwitch = phoneList ? (
    <div className="fv-phone-switch" role="tablist">
      <button role="tab" aria-selected={phoneView === "list"} className={phoneView === "list" ? "on" : ""} onClick={() => setPhoneView("list")}>
        List · {order.length}
      </button>
      <button role="tab" aria-selected={phoneView === "record"} className={phoneView === "record" ? "on" : ""} onClick={() => setPhoneView("record")}>
        {isNew ? "New record" : "Record"}
      </button>
    </div>
  ) : null;

  return (
    <div ref={rootRef} className={`fv theme-${layout.theme} ${phone ? "compact" : ""} ${finding ? "finding" : ""}`} style={themeStyle(layout.theme)}>
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
      {mode !== "datasheet" && <div ref={setScrollEl} className={`fv-scroll ${mode === "split" ? "split-top" : ""}`}>
        <div
          className={`fv-card ${mode === "continuous" ? "continuous" : ""}`}
          style={phone ? undefined : { width: layout.width, ...(fit < 1 ? { zoom: fit } : {}) }}
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
          {mode === "continuous" ? (
            <>
              {sectionHeight("header") > 0 && (
                <div className="fv-section fv-header fv-sticky" style={phone ? undefined : { height: sectionHeight("header") }}>
                  {sectionBody("header")}
                </div>
              )}
              {continuousRecs.map((rec) => {
                const current = rec.isNew ? isNew : !isNew && rec.p === pos;
                return (
                  <div
                    key={rec.isNew ? "new" : keyOf(rec.rowIndex!)}
                    className={`fv-section fv-detail fv-rec ${current ? "current" : ""} ${rec.isNew ? "new" : ""}`}
                    style={phone ? undefined : { height: sectionHeight("detail") }}
                    onMouseDownCapture={() => selectRec(rec)}
                    onFocusCapture={() => selectRec(rec)}
                  >
                    {sectionBody("detail", rec)}
                  </div>
                );
              })}
              {order.length > limit && (
                <div className="fv-more">
                  <button onClick={() => setLimit((n) => n + 200)}>
                    Show more ({order.length - limit} more record{order.length - limit === 1 ? "" : "s"})
                  </button>
                </div>
              )}
              {!order.length && !canAdd && <div className="fv-empty muted">No records.</div>}
              {sectionHeight("footer") > 0 && (
                <div className="fv-section fv-footer" style={phone ? undefined : { height: sectionHeight("footer") }}>
                  {sectionBody("footer")}
                </div>
              )}
            </>
          ) : (
            (["header", "detail", "footer"] as const).map((s) =>
              sectionHeight(s) > 0 && !(showCards && s !== "header") ? (
                <Fragment key={s}>
                  <div className={`fv-section fv-${s}`} style={phone ? undefined : { height: sectionHeight(s) }}>
                    {sectionBody(s)}
                  </div>
                  {phoneList && s === "header" && phoneSwitch}
                </Fragment>
              ) : null,
            )
          )}
          {phoneList && !sectionHeight("header") && phoneSwitch}
          {showCards && (
            <PhoneCards
              count={order.length}
              limit={limit}
              onMore={() => setLimit((n) => n + 200)}
              card={phoneCard}
              current={isNew ? -1 : pos}
              canAdd={canAdd}
              onOpen={(p) => {
                setIsNew(false);
                setPos(p);
                setPhoneView("record");
                // Show the record from its top (the switch), not from wherever the list was scrolled to.
                requestAnimationFrame(() => rootRef.current?.querySelector(".fv-phone-switch")?.scrollIntoView({ block: "start" }));
              }}
              onNew={() => {
                goNew();
                setPhoneView("record");
              }}
            />
          )}
        </div>
      </div>}
      {(mode === "datasheet" || mode === "split") && (
        <div className={`fv-sheet ${mode}`}>
          <Datasheet
            key={embedded ? String(embedded.value ?? "") : "sheet"}
            columns={sheetColumns}
            rowCount={order.length}
            filtered={!!where || filterOn}
            getValue={sheetValue}
            rowKey={(r) => keyOf(order[r])}
            editable={!ws.readOnly && !readOnlyMode && !embedded?.readOnly && layout.allowEdits !== false}
            allowNew={canAdd}
            autoFocus={false}
            onCommit={(r, col, input) => {
              const c = sheetControls[col];
              const ci = c?.field ? colIdx(c.field) : -1;
              if (ci < 0) return "This column can't be edited.";
              return commitAt(r === "new" ? { row: null, rowIndex: undefined, isNew: true, p: -1 } : { row: data.rows[order[r]], rowIndex: order[r], isNew: false, p: r }, ci, input);
            }}
            onDeleteRows={(rs) => void editor.deleteRows(rs.map((r) => order[r]))}
            newRowPlaceholder={(col) => (sheetControls[col]?.field && data.fields[colIdx(sheetControls[col].field!)]?.type === "AutoNumber" ? "(New)" : "")}
            onStatus={ws.setStatus}
            onCurrentRow={(r) => (r === "new" ? !isNew && canAdd && setIsNew(true) : (isNew || r !== pos) && (setIsNew(false), setPos(r)))}
            emptyMessage={linkBlocked ? "Fill in the main form's record first." : canAdd ? undefined : "No records."}
          />
        </div>
      )}
      {!finding && !showCards && !!form.source && mode !== "datasheet" && mode !== "split" && (layout.navigationButtons !== false || filter || where) && (
        <div className="record-nav">
          <span className="rn-label">Record:</span>
          <button onClick={() => go(0)} disabled={!count} title="First record">⏮</button>
          <button onClick={() => go(isNew ? count - 1 : pos - 1)} disabled={!isNew && pos <= 0} title="Previous record">◀</button>
          <span className="rn-pos static">{isNew ? `${count + 1} of ${count + 1}` : `${count ? pos + 1 : 0} of ${count}`}</span>
          <button onClick={() => go(pos + 1)} disabled={isNew || pos >= count - 1} title="Next record">▶</button>
          <button onClick={() => go(count - 1)} disabled={!count} title="Last record">⏭</button>
          <button onClick={goNew} disabled={!canAdd} title="New (blank) record">▶*</button>
          {where && (!filter || !filterOn) && (
            <button className="rn-filter-toggle on" onClick={toggleFilter} title={`Showing the records where ${where}. Click to show all records.`}>
              Filtered
            </button>
          )}
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
          {!table && !data.edit?.ok && <span className="rn-filter" title={data.edit && !data.edit.ok ? data.edit.reason : undefined}>Read-only (query)</span>}
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

/** A phone's list of records: one card each, tap to open; a search box narrows them. */
function PhoneCards(p: {
  count: number;
  limit: number;
  onMore: () => void;
  card: (pos: number) => { key: string; title: string; lines: { label: string; text: string }[] };
  current: number;
  canAdd: boolean;
  onOpen: (pos: number) => void;
  onNew: () => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const cards: { pos: number; card: ReturnType<typeof p.card> }[] = [];
  for (let i = 0; i < p.count && cards.length < p.limit; i++) {
    const card = p.card(i);
    if (needle && !`${card.title} ${card.lines.map((l) => l.text).join(" ")}`.toLowerCase().includes(needle)) continue;
    cards.push({ pos: i, card });
  }
  return (
    <div className="fv-cards">
      <div className="fv-cards-bar">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${p.count} record${p.count === 1 ? "" : "s"}`} aria-label="Search these records" />
        {p.canAdd && (
          <button type="button" onClick={p.onNew}>
            + New
          </button>
        )}
      </div>
      {cards.map(({ pos, card }) => (
        <button key={card.key} type="button" className={`fv-card-item ${pos === p.current ? "current" : ""}`} onClick={() => p.onOpen(pos)}>
          <span className="fv-card-title">{card.title}</span>
          {card.lines.map((l, i) => (
            <span key={i} className="fv-card-line">
              <span className="fv-card-label">{l.label}</span> {l.text}
            </span>
          ))}
          <span className="fv-card-go" aria-hidden>
            ›
          </span>
        </button>
      ))}
      {!cards.length && <div className="fv-empty muted">{needle ? "No records match." : "No records."}</div>}
      {p.count > p.limit && !needle && (
        <div className="fv-more">
          <button onClick={p.onMore}>Show more ({p.count - p.limit} more)</button>
        </div>
      )}
    </div>
  );
}
