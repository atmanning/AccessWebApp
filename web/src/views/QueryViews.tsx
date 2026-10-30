import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NAME_PATTERN, QUERY_TYPE_LABELS, TOTAL_OPTIONS, type QueryColumn, type QueryDef, type QueryType } from "../../../shared/model";
import { runQuery, type ResultSet } from "../engine/engine";
import { previewAction } from "../engine/actions";
import { loadLinkedTables } from "../engine/linked";
import { isActionType } from "../engine/statements";
import { designProblem, designSql, type QueryDesign } from "../engine/queryDesign";
import { ComboBox, type ComboOption } from "../ui/ComboBox";
import { Modal, useDialogs } from "../ui/dialogs";
import { KeyIcon, TableIcon } from "../ui/icons";
import { useCommands, useWorkspace } from "../workspace/context";
import { useRecordEditing } from "../workspace/useTableEditing";
import { useRunAction } from "../workspace/useRunAction";
import { QUERY_TYPE_ICONS, typeOfQuery } from "../workspace/queryKinds";
import { parseInput } from "../engine/values";
import { exportCsv } from "../workspace/csv";
import { Datasheet, type DatasheetHandle } from "./Datasheet";

/** Runs a query and shows the results read-only. */
export function QueryDatasheet({ query, tabKey }: { query: QueryDef; tabKey: string }) {
  const ws = useWorkspace();
  const { commitTo, deleteFrom } = useRecordEditing();
  const [result, setResult] = useState<ResultSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const grid = useRef<DatasheetHandle>(null);

  // Like Access, results are fetched when the query opens (or on Refresh All) and edits update
  // them in place, so a record you change doesn't vanish just because it no longer matches.
  useEffect(() => {
    let cancelled = false;
    setRunning(true);
    const action = isActionType(typeOfQuery(query));
    let linkedNotes: string[] = [];
    // Linked MySQL tables the query uses are fetched first (see engine/linked.ts).
    loadLinkedTables(ws.doc, ws.projectId, query.sql)
      .then(({ tables, notes }) => {
        linkedNotes = notes;
        return action
          ? previewAction(ws.doc, query.sql, query.id, tables)
          : runQuery(ws.doc, query.sql, { excludeQueryId: query.id, editable: true, extraTables: tables });
      })
      .then((r) => {
        if (cancelled) return;
        setResult(r);
        setError(null);
        if (linkedNotes.length) return ws.setStatus(linkedNotes.join(" "));
        ws.setStatus(
          action
            ? `Preview: the ${r.rows.length} record(s) this ${QUERY_TYPE_LABELS[typeOfQuery(query)].toLowerCase()} query will ${typeOfQuery(query) === "delete" ? "delete" : typeOfQuery(query) === "update" ? "change" : "add"}. Click Run to apply it.`
            : r.rows.length >= 50_000
              ? "Showing the first 50,000 records."
              : "",
        );
      })
      .catch((e: Error) => !cancelled && (setError(e.message), setResult(null)))
      .finally(() => !cancelled && setRunning(false));
    return () => {
      cancelled = true;
    };
  }, [query.sql, query.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // View-only users see results read-only.
  const edit = result?.edit?.ok && !ws.readOnly ? result.edit : null;
  const columns = useMemo(
    () =>
      (result?.columns ?? []).map((c, i) => {
        const editable = !!edit?.columns[i];
        return {
          key: `${i}:${c}`,
          label: c,
          field: result?.fields[i],
          readOnly: !editable,
          readOnlyReason: edit
            ? `'${c}' is calculated by the query, so it can't be edited.`
            : result?.edit && !result.edit.ok
              ? result.edit.reason
              : undefined,
        };
      }),
    [result, edit],
  );
  const getValue = useCallback((r: number, c: number) => result?.rows[r]?.[c] ?? null, [result]);
  const savedWidths = useMemo(
    () => Object.fromEntries(columns.flatMap((c) => (query.columnWidths?.[c.label] ? [[c.key, query.columnWidths[c.label]]] : []))),
    [columns], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /** Writes one cell back to its table, then updates every result cell showing that same value. */
  const onCommit = (row: number | "new", col: number, input: string | boolean): string | null => {
    if (!edit || !result || row === "new") return "This record can't be edited.";
    const map = edit.columns[col];
    if (!map) return columns[col].readOnlyReason ?? "This field can't be edited.";
    const table = ws.doc.tables.find((t) => t.id === edit.tables[map.source].id);
    const rowId = edit.rowIds[row][map.source];
    const rowIdx = table && rowId ? table.rows.findIndex((r) => r._id === rowId) : -1;
    if (!table || rowIdx < 0) return "This record was deleted. Click Refresh All to update the results.";
    const err = commitTo(table, rowIdx, map.fieldId, input);
    if (err) return err;
    const field = table.fields.find((f) => f.id === map.fieldId)!;
    const parsed = parseInput(field, input);
    const value = parsed.ok ? parsed.value : null;
    setResult((prev) => {
      if (!prev?.edit?.ok) return prev;
      const e = prev.edit;
      const rows = prev.rows.map((r, ri) => {
        let copy: typeof r | null = null;
        e.columns.forEach((m, ci) => {
          if (m && e.tables[m.source].id === table.id && m.fieldId === map.fieldId && e.rowIds[ri][m.source] === rowId) {
            copy ??= [...r];
            copy[ci] = value;
          }
        });
        return copy ?? r;
      });
      return { ...prev, rows };
    });
    return null;
  };

  const onDeleteRows = async (rows: number[]) => {
    if (!edit || !result) return;
    if (edit.tables.length !== 1) {
      ws.setStatus("Records can only be deleted from a query that uses a single table. Delete them from the table instead.", "error");
      return;
    }
    const table = ws.doc.tables.find((t) => t.id === edit.tables[0].id);
    if (!table) return;
    const ids = new Set(rows.map((r) => edit.rowIds[r][0]));
    const indexes = table.rows.flatMap((r, i) => (ids.has(r._id as string) ? [i] : []));
    if (await deleteFrom(table, indexes)) {
      setResult((prev) => {
        if (!prev?.edit?.ok) return prev;
        const e = prev.edit;
        const keep = prev.rows.map((_, i) => !ids.has(e.rowIds[i][0]));
        return { ...prev, rows: prev.rows.filter((_, i) => keep[i]), edit: { ...e, rowIds: e.rowIds.filter((_, i) => keep[i]) } };
      });
    }
  };

  const runAction = useRunAction();
  useCommands(tabKey, {
    run: () => void runAction(query),
    sortAsc: () => grid.current?.sort("ASC"),
    sortDesc: () => grid.current?.sort("DESC"),
    removeSort: () => grid.current?.sort(null),
    find: () => grid.current?.focusFind(),
    deleteRecord: edit ? () => grid.current?.deleteSelected() : undefined,
    exportText: () => result && exportCsv(query.name, result.columns, result.rows, result.fields),
  });

  if (error) {
    return (
      <div className="query-error">
        <strong>The query couldn't run.</strong>
        <p>{error}</p>
        <p className="muted">Switch to SQL View or Design View to fix it.</p>
      </div>
    );
  }
  if (!result) return <div className="empty-view">{running ? "Running query…" : ""}</div>;
  return (
    <Datasheet
      ref={grid}
      columns={columns}
      rowCount={result.rows.length}
      getValue={getValue}
      rowKey={(r) => String(r)}
      editable={!!edit}
      allowNew={false}
      onCommit={onCommit}
      onDeleteRows={(rows) => void onDeleteRows(rows)}
      emptyMessage="The query returned no records."
      onStatus={ws.setStatus}
      savedWidths={savedWidths}
      onWidthsChange={(w) => {
        if (ws.readOnly) return;
        // Stored by column name so they survive changes to the query's SQL.
        const byName = Object.fromEntries(columns.filter((c) => w[c.key]).map((c) => [c.label, w[c.key]]));
        ws.update((d) => {
          const q = d.queries.find((x) => x.id === query.id);
          if (q) q.columnWidths = byName;
        });
      }}
    />
  );
}

export function QuerySqlView({ query, tabKey }: { query: QueryDef; tabKey: string }) {
  const ws = useWorkspace();
  const [text, setText] = useState(query.sql);
  const latest = useRef(text);
  latest.current = text;

  useEffect(() => setText(query.sql), [query.sql]);

  const commit = useCallback(() => {
    if (latest.current === query.sql) return;
    const sql = latest.current;
    ws.update((d) => {
      const q = d.queries.find((x) => x.id === query.id)!;
      q.sql = sql;
      q.mode = "sql";
    });
  }, [query.sql, query.id, ws]);

  // Save edits when the tab closes or switches view.
  useEffect(() => () => commit(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const runAction = useRunAction();
  const run = async () => {
    commit();
    if (!(await runAction(query, latest.current))) ws.setTabView(tabKey, "datasheet");
  };
  useCommands(tabKey, { run });

  return (
    <div className="sql-view">
      <textarea
        className="sql-editor"
        value={text}
        spellCheck={false}
        aria-label="SQL"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void run();
        }}
      />
      <div className="sql-hint">
        Access SQL: use [Brackets] for names, "text" or 'text', #12/31/2026# for dates, &amp; to join text, Like "A*" wildcards.
        Functions such as IIf, Nz, Left, Mid, Len, UCase, Year and Now work. UPDATE, DELETE, INSERT INTO, SELECT … INTO and
        TRANSFORM … PIVOT queries run too. Ctrl+Enter runs the query.
      </div>
    </div>
  );
}

const TOTAL_COMBO = TOTAL_OPTIONS.map((t) => ({ value: t, label: t }));
const CROSSTAB_OPTIONS: ComboOption<NonNullable<QueryColumn["crosstab"]>>[] = [
  { value: "", label: "(not shown)" },
  { value: "row", label: "Row Heading" },
  { value: "column", label: "Column Heading" },
  { value: "value", label: "Value" },
];

function QueryTypeIcon({ type }: { type: QueryType }) {
  const Icon = QUERY_TYPE_ICONS[type];
  return <Icon size={16} />;
}

function AppendTargetDialog(props: { current?: string; onClose: () => void; onPick: (table: string) => void }) {
  const ws = useWorkspace();
  const tables = ws.doc.tables.map((t) => t.name);
  const [picked, setPicked] = useState(props.current ?? tables[0] ?? "");
  return (
    <Modal
      title="Append"
      onClose={props.onClose}
      width={380}
      footer={
        <>
          <button className="primary" disabled={!picked} onClick={() => props.onPick(picked)}>OK</button>
          <button onClick={props.onClose}>Cancel</button>
        </>
      }
    >
      <p>Append to table:</p>
      <ComboBox className="text-input" value={picked} ariaLabel="Table Name" options={tables.map((t) => ({ value: t, label: t }))} onChange={setPicked} />
      <p className="small muted" style={{ marginTop: 10 }}>Then pick each column's target field in the Append To row. Fields with matching names are filled in for you.</p>
    </Modal>
  );
}

const SORT_OPTIONS: ComboOption<QueryColumn["sort"]>[] = [
  { value: "", label: "(not sorted)" },
  { value: "ASC", label: "Ascending" },
  { value: "DESC", label: "Descending" },
];

const EMPTY_COL: QueryColumn = { table: "", field: "", show: true, sort: "", criteria: "" };

export function QueryDesignView({ query, tabKey }: { query: QueryDef; tabKey: string }) {
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const runAction = useRunAction();
  const [showTables, setShowTables] = useState(false);
  const [appendPicker, setAppendPicker] = useState(false);
  // Column selection/move/resize state (kept above the early return: hooks must always run).
  const [selectedCol, setSelectedCol] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [liveWidths, setLiveWidths] = useState<Record<number, number>>({});
  const dragFrom = useRef<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const design: QueryDesign = query.design ?? { tables: [], columns: [] };
  const type: QueryType = design.type ?? "select";
  const totalsOn = type === "crosstab" || (!!design.totals && (type === "select" || type === "makeTable" || type === "append"));
  const generated = useMemo(() => designSql(ws.doc, design), [ws.doc, design]);
  const sqlDiverged = query.mode === "sql" && query.sql.trim() !== generated.trim();
  const problem = designProblem(ws.doc, design);
  const appendTable = type === "append" ? ws.doc.tables.find((t) => t.name === design.target) : undefined;

  const setDesign = (fn: (dz: QueryDesign) => void) =>
    ws.update((d) => {
      const q = d.queries.find((x) => x.id === query.id)!;
      q.design ??= { tables: [], columns: [] };
      fn(q.design);
      q.design.columns = q.design.columns.filter((c) => c.field);
      q.sql = designSql(d, q.design);
      q.mode = "design";
    });

  /** Append To defaults to the target field with the same name, like Access. */
  const autoAppendTo = (dz: QueryDesign, target?: string) => {
    const t = ws.doc.tables.find((x) => x.name === (target ?? dz.target));
    for (const c of dz.columns) {
      if (c.field === "*" || !t) continue;
      c.appendTo = t.fields.find((f) => f.name.toLowerCase() === c.field.toLowerCase() && f.type !== "AutoNumber")?.name ?? c.appendTo;
    }
  };

  const setQueryType = async (next: QueryType) => {
    if (next === "makeTable") {
      const name = await dialogs.prompt(
        "Make Table",
        "Table Name (an existing table with this name is replaced when the query runs):",
        design.target ?? `${query.name} Table`.slice(0, 64),
        (v) => (!v.trim() ? "Enter a table name." : !NAME_PATTERN.test(v.trim()) ? "Names can't contain . ! ` [ or ]." : ws.doc.queries.some((q) => q.name.toLowerCase() === v.trim().toLowerCase()) ? "A query has that name." : null),
      );
      if (!name) return;
      setDesign((dz) => {
        dz.type = "makeTable";
        dz.target = name;
      });
    } else if (next === "append") {
      setAppendPicker(true);
      return;
    } else {
      setDesign((dz) => {
        dz.type = next;
        delete dz.target; // only Make Table and Append have a target table
        if (next === "crosstab") for (const c of dz.columns) c.total ??= "Group By";
      });
    }
    ws.setStatus(`${QUERY_TYPE_LABELS[next]} query.${next === "select" || next === "crosstab" ? "" : " Datasheet View previews the records it changes; click Run to apply it."}`);
  };

  const run = async () => {
    if (problem) return ws.setStatus(problem, "error");
    if (!(await runAction(query))) ws.setTabView(tabKey, "datasheet");
  };

  useCommands(tabKey, {
    run,
    showTable: () => setShowTables(true),
    setQueryType,
    queryType: type,
    totals: totalsOn,
    toggleTotals:
      type === "select" || type === "makeTable" || type === "append"
        ? () =>
            setDesign((dz) => {
              dz.totals = !dz.totals;
            })
        : undefined,
  });

  useEffect(() => {
    if (!sqlDiverged && design.tables.length === 0 && ws.doc.tables.length) setShowTables(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (sqlDiverged) {
    return (
      <div className="query-error">
        <strong>This query was changed in SQL View.</strong>
        <p>Design View can't show SQL that was typed by hand. You can keep working in SQL View, or rebuild the query in the design grid (your SQL edits will be replaced).</p>
        <div className="button-row">
          <button className="primary" onClick={() => ws.setTabView(tabKey, "sql")}>Go to SQL View</button>
          <button
            onClick={async () => {
              if (await dialogs.confirm("Microsoft Access Web", "Replace the SQL with the query from the design grid?", { okLabel: "Replace" })) {
                setDesign(() => {});
              }
            }}
          >
            Use the design grid
          </button>
        </div>
      </div>
    );
  }

  const fieldOptions = design.tables.flatMap((t) => {
    const table = ws.doc.tables.find((x) => x.name === t);
    return table ? [{ table: t, field: "*" }, ...table.fields.map((f) => ({ table: t, field: f.name }))] : [];
  });
  const cols = [...design.columns];
  while (cols.length < Math.max(8, design.columns.length + 2)) cols.push(EMPTY_COL);

  const addField = (table: string, field: string) =>
    setDesign((dz) => {
      const firstEmpty = dz.columns.findIndex((c) => !c.field);
      const col: QueryColumn = { ...EMPTY_COL, table, field, ...(dz.type === "crosstab" ? { total: "Group By" as const } : {}) };
      if (firstEmpty >= 0) dz.columns[firstEmpty] = col;
      else dz.columns.push(col);
      if (dz.type === "append") autoAppendTo(dz);
    });

  const setCol = (i: number, patch: Partial<QueryColumn>) =>
    setDesign((dz) => {
      while (dz.columns.length <= i) dz.columns.push({ ...EMPTY_COL });
      Object.assign(dz.columns[i], patch);
      if (!dz.columns[i].field) dz.columns.splice(i, 1);
    });

  // ---- Selecting, moving and resizing grid columns (the grey bar above each column) ----
  const used = design.columns.length;
  const widthOf = (i: number) => liveWidths[i] ?? cols[i]?.width ?? 130;

  const moveColumn = (from: number, to: number) => {
    const target = Math.max(0, Math.min(used - 1, to > from ? to - 1 : to));
    if (from >= used || target === from) return;
    setDesign((dz) => {
      const [c] = dz.columns.splice(from, 1);
      dz.columns.splice(target, 0, c);
    });
    setSelectedCol(target);
  };

  const startColResize = (e: React.MouseEvent, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthOf(i);
    let w = startW;
    const move = (ev: MouseEvent) => {
      w = Math.round(Math.max(60, Math.min(600, startW + ev.clientX - startX)));
      setLiveWidths((lw) => ({ ...lw, [i]: w }));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setLiveWidths((lw) => {
        const { [i]: _, ...rest } = lw;
        return i < used ? rest : lw; // empty columns keep the width for this session only
      });
      if (i < used && w !== startW) setCol(i, { width: w });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const colClass = (i: number) => (i === selectedCol ? "qd-col-selected" : "");

  return (
    <div className="query-design">
      <div className="qd-tables">
        {design.tables.map((t) => {
          const table = ws.doc.tables.find((x) => x.name === t);
          return (
            <div className="field-list" key={t}>
              <div className="field-list-title">
                <span>{t}</span>
                <button
                  className="icon-btn"
                  aria-label={`Remove ${t}`}
                  title="Remove table"
                  onClick={() =>
                    setDesign((dz) => {
                      dz.tables = dz.tables.filter((x) => x !== t);
                      dz.columns = dz.columns.filter((c) => c.table !== t);
                    })
                  }
                >
                  ×
                </button>
              </div>
              <ul>
                <li onDoubleClick={() => addField(t, "*")} title="Double-click to add all fields">*</li>
                {table?.fields.map((f) => (
                  <li key={f.id} onDoubleClick={() => addField(t, f.name)} title="Double-click to add to the grid">
                    {f.primaryKey && <KeyIcon size={11} />} {f.name}
                  </li>
                )) ?? <li className="muted">(table deleted)</li>}
              </ul>
            </div>
          );
        })}
        {!design.tables.length && (
          <div className="qd-empty">
            <button onClick={() => setShowTables(true)}>
              <TableIcon /> Show Table…
            </button>
          </div>
        )}
      </div>
      <div className={`qd-info ${problem ? "warn" : ""}`}>
        <QueryTypeIcon type={type} />
        <strong>{QUERY_TYPE_LABELS[type]} query</strong>
        {type === "makeTable" && design.target && <span>· new table: <strong>{design.target}</strong> <button className="link" onClick={() => setQueryType("makeTable")}>change</button></span>}
        {type === "append" && design.target && <span>· append to: <strong>{design.target}</strong> <button className="link" onClick={() => setAppendPicker(true)}>change</button></span>}
        {problem && design.columns.length > 0 && <span className="qd-problem">{problem}</span>}
      </div>
      <div
        className="qd-grid-wrap"
        ref={gridRef}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (selectedCol === null || selectedCol >= used || (e.target as HTMLElement) !== gridRef.current) return;
          if (e.key === "Delete") {
            e.preventDefault();
            setCol(selectedCol, { field: "", table: "" });
            setSelectedCol(null);
          } else if (e.key === "ArrowLeft" && e.ctrlKey) {
            e.preventDefault();
            moveColumn(selectedCol, selectedCol - 1);
          } else if (e.key === "ArrowRight" && e.ctrlKey) {
            e.preventDefault();
            moveColumn(selectedCol, selectedCol + 2);
          } else if (e.key === "Escape") setSelectedCol(null);
        }}
        onMouseDown={(e) => {
          if (!(e.target as HTMLElement).closest(".qd-sel")) setSelectedCol(null);
        }}
      >
        <table className="qd-grid" style={{ width: "max-content" }}>
          <colgroup>
            <col />
            {cols.map((_, i) => (
              <col key={i} style={{ width: widthOf(i) }} />
            ))}
          </colgroup>
          <tbody>
            <tr className="qd-selectors">
              <th aria-hidden="true" />
              {cols.map((c, i) => (
                <td
                  key={i}
                  className={`qd-sel ${colClass(i)} ${dropAt === i ? "drop-before" : ""} ${dropAt === cols.length && i === used - 1 ? "drop-after" : ""}`}
                  title={c.field ? "Click to select; drag to move; drag the right edge to resize; Delete removes it" : undefined}
                  draggable={!!c.field}
                  onMouseDown={() => {
                    if (!c.field) return;
                    setSelectedCol(i);
                    gridRef.current?.focus();
                  }}
                  onDragStart={(e) => {
                    dragFrom.current = i;
                    setSelectedCol(i);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", String(i));
                  }}
                  onDragOver={(e) => {
                    if (dragFrom.current === null) return;
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    const after = e.clientX > r.left + r.width / 2;
                    // Beyond the last used column, dropping means "move to the end".
                    setDropAt(i >= used ? cols.length : after ? i + 1 : i);
                  }}
                  onDragLeave={() => setDropAt(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = dragFrom.current;
                    const to = dropAt ?? i;
                    dragFrom.current = null;
                    setDropAt(null);
                    if (from !== null) moveColumn(from, to >= cols.length ? used : to);
                  }}
                  onDragEnd={() => {
                    dragFrom.current = null;
                    setDropAt(null);
                  }}
                >
                  <span className="qd-resizer" onMouseDown={(e) => startColResize(e, i)} title="Drag to resize" />
                </td>
              ))}
            </tr>
            <tr>
              <th>Field:</th>
              {cols.map((c, i) => (
                <td key={i} className={colClass(i)}>
                  <ComboBox
                    value={c.field ? `${c.table}\u0000${c.field}` : ""}
                    ariaLabel={`Field ${i + 1}`}
                    options={[
                      { value: "", label: "" },
                      ...fieldOptions.map((o) => ({
                        value: `${o.table}\u0000${o.field}`,
                        label: design.tables.length > 1 ? `${o.table}.${o.field}` : o.field,
                      })),
                    ]}
                    onChange={(v) => {
                      const [table, field] = v ? v.split("\u0000") : ["", ""];
                      setCol(i, { table, field });
                    }}
                  />
                </td>
              ))}
            </tr>
            <tr>
              <th>Table:</th>
              {cols.map((c, i) => (
                <td key={i} className={`qd-static ${colClass(i)}`}>{c.table}</td>
              ))}
            </tr>
            {totalsOn && (
              <tr>
                <th>Total:</th>
                {cols.map((c, i) => (
                  <td key={i} className={colClass(i)}>
                    <ComboBox
                      value={c.total ?? "Group By"}
                      ariaLabel={`Total ${i + 1}`}
                      disabled={!c.field}
                      options={TOTAL_COMBO}
                      onChange={(v) => setCol(i, { total: v })}
                    />
                  </td>
                ))}
              </tr>
            )}
            {type === "crosstab" && (
              <tr>
                <th>Crosstab:</th>
                {cols.map((c, i) => (
                  <td key={i} className={colClass(i)}>
                    <ComboBox
                      value={c.crosstab ?? ""}
                      ariaLabel={`Crosstab ${i + 1}`}
                      disabled={!c.field || c.field === "*"}
                      options={CROSSTAB_OPTIONS}
                      onChange={(v) => setCol(i, { crosstab: v, ...(v === "value" && (!c.total || c.total === "Group By") ? { total: "Sum" as const } : {}) })}
                    />
                  </td>
                ))}
              </tr>
            )}
            {type === "update" && (
              <tr>
                <th>Update To:</th>
                {cols.map((c, i) => (
                  <td key={i} className={colClass(i)}>
                    <input
                      defaultValue={c.updateTo ?? ""}
                      key={`u${i}:${c.field}:${c.updateTo}`}
                      disabled={!c.field || c.field === "*"}
                      placeholder={c.field && c.field !== "*" ? 'e.g. "Closed" or [Price]*1.1' : ""}
                      aria-label={`Update To ${i + 1}`}
                      onBlur={(e) => e.target.value !== (c.updateTo ?? "") && setCol(i, { updateTo: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                  </td>
                ))}
              </tr>
            )}
            {type === "delete" && (
              <tr>
                <th>Delete:</th>
                {cols.map((c, i) => (
                  <td key={i} className={`qd-static ${colClass(i)}`}>{c.field ? (c.field === "*" ? "From" : "Where") : ""}</td>
                ))}
              </tr>
            )}
            {type !== "update" && type !== "delete" && (
              <tr>
                <th>Sort:</th>
                {cols.map((c, i) => (
                  <td key={i} className={colClass(i)}>
                    <ComboBox
                      value={c.sort}
                      ariaLabel={`Sort ${i + 1}`}
                      disabled={!c.field || c.field === "*"}
                      options={SORT_OPTIONS}
                      onChange={(v) => setCol(i, { sort: v })}
                    />
                  </td>
                ))}
              </tr>
            )}
            {type === "append" && (
              <tr>
                <th>Append To:</th>
                {cols.map((c, i) => (
                  <td key={i} className={colClass(i)}>
                    <ComboBox
                      value={c.appendTo ?? ""}
                      ariaLabel={`Append To ${i + 1}`}
                      disabled={!c.field || c.field === "*"}
                      options={[{ value: "", label: "" }, ...(appendTable?.fields.map((f) => ({ value: f.name, label: f.name })) ?? [])]}
                      onChange={(v) => setCol(i, { appendTo: v || undefined })}
                    />
                  </td>
                ))}
              </tr>
            )}
            {(type === "select" || type === "makeTable") && (
              <tr>
                <th>Show:</th>
                {cols.map((c, i) => (
                  <td key={i} className={`center ${colClass(i)}`}>
                    <input
                      type="checkbox"
                      checked={c.show && !(totalsOn && c.total === "Where")}
                      disabled={!c.field || (totalsOn && c.total === "Where")}
                      onChange={(e) => setCol(i, { show: e.target.checked })}
                    />
                  </td>
                ))}
              </tr>
            )}
            <tr>
              <th>Criteria:</th>
              {cols.map((c, i) => (
                <td key={i} className={colClass(i)}>
                  <input
                    defaultValue={c.criteria}
                    key={`${i}:${c.field}:${c.criteria}`}
                    disabled={!c.field || c.field === "*"}
                    placeholder={c.field && c.field !== "*" ? "e.g. >10" : ""}
                    onBlur={(e) => e.target.value !== c.criteria && setCol(i, { criteria: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  />
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {appendPicker && (
        <AppendTargetDialog
          current={design.target}
          onClose={() => setAppendPicker(false)}
          onPick={(target) => {
            setAppendPicker(false);
            setDesign((dz) => {
              dz.type = "append";
              dz.target = target;
              autoAppendTo(dz, target);
            });
            ws.setStatus("Append query. Datasheet View previews the records it adds; click Run to apply it.");
          }}
        />
      )}
      {showTables && (
        <ShowTableDialog
          existing={design.tables}
          onClose={() => setShowTables(false)}
          onAdd={(names) =>
            setDesign((dz) => {
              for (const n of names) if (!dz.tables.includes(n)) dz.tables.push(n);
            })
          }
        />
      )}
    </div>
  );
}

function ShowTableDialog(props: { existing: string[]; onClose: () => void; onAdd: (names: string[]) => void }) {
  const ws = useWorkspace();
  const [picked, setPicked] = useState<string[]>([]);
  const tables = ws.doc.tables.map((t) => t.name);
  return (
    <Modal
      title="Show Table"
      onClose={props.onClose}
      width={340}
      footer={
        <>
          <button
            className="primary"
            disabled={!picked.length}
            onClick={() => {
              props.onAdd(picked);
              setPicked([]);
            }}
          >
            Add
          </button>
          <button onClick={props.onClose}>Close</button>
        </>
      }
    >
      <div className="list-box" role="listbox" aria-multiselectable="true">
        {tables.map((t) => (
          <div
            key={t}
            role="option"
            aria-selected={picked.includes(t)}
            className={`list-item ${picked.includes(t) ? "selected" : ""} ${props.existing.includes(t) ? "muted" : ""}`}
            onClick={(e) => setPicked((p) => (e.ctrlKey || e.metaKey ? (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]) : [t]))}
            onDoubleClick={() => props.onAdd([t])}
          >
            <TableIcon /> {t}
          </div>
        ))}
        {!tables.length && <div className="muted pad">There are no tables yet.</div>}
      </div>
      <p className="muted small">Ctrl+click to pick several. Related tables are joined automatically using your relationships.</p>
    </Modal>
  );
}
