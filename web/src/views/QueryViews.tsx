import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { QueryColumn, QueryDef } from "../../../shared/model";
import { runQuery, type ResultSet } from "../engine/engine";
import { designToSql } from "../engine/queryDesign";
import { ComboBox, type ComboOption } from "../ui/ComboBox";
import { Modal, useDialogs } from "../ui/dialogs";
import { KeyIcon, TableIcon } from "../ui/icons";
import { useCommands, useWorkspace } from "../workspace/context";
import { useRecordEditing } from "../workspace/useTableEditing";
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
    runQuery(ws.doc, query.sql, { excludeQueryId: query.id, editable: true })
      .then((r) => {
        if (cancelled) return;
        setResult(r);
        setError(null);
        ws.setStatus(r.rows.length >= 50_000 ? "Showing the first 50,000 records." : "");
      })
      .catch((e: Error) => !cancelled && (setError(e.message), setResult(null)))
      .finally(() => !cancelled && setRunning(false));
    return () => {
      cancelled = true;
    };
  }, [query.sql, query.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = result?.edit?.ok ? result.edit : null;
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

  useCommands(tabKey, {
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

  useCommands(tabKey, {
    run: () => {
      commit();
      ws.setTabView(tabKey, "datasheet");
    },
  });

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
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            commit();
            ws.setTabView(tabKey, "datasheet");
          }
        }}
      />
      <div className="sql-hint">
        Access SQL: use [Brackets] for names, "text" or 'text', #12/31/2026# for dates, &amp; to join text, Like "A*" wildcards.
        Functions such as IIf, Nz, Left, Mid, Len, UCase, Year and Now work. Ctrl+Enter runs the query.
      </div>
    </div>
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
  const [showTables, setShowTables] = useState(false);
  const design = query.design ?? { tables: [], columns: [] };
  const generated = useMemo(() => designToSql(ws.doc, design.tables, design.columns), [ws.doc, design]);
  const sqlDiverged = query.mode === "sql" && query.sql.trim() !== generated.trim();

  const setDesign = (fn: (dz: { tables: string[]; columns: QueryColumn[] }) => void) =>
    ws.update((d) => {
      const q = d.queries.find((x) => x.id === query.id)!;
      q.design ??= { tables: [], columns: [] };
      fn(q.design);
      q.design.columns = q.design.columns.filter((c) => c.field);
      q.sql = designToSql(d, q.design.tables, q.design.columns);
      q.mode = "design";
    });

  useCommands(tabKey, {
    run: () => ws.setTabView(tabKey, "datasheet"),
    showTable: () => setShowTables(true),
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
      const col = { ...EMPTY_COL, table, field };
      if (firstEmpty >= 0) dz.columns[firstEmpty] = col;
      else dz.columns.push(col);
    });

  const setCol = (i: number, patch: Partial<QueryColumn>) =>
    setDesign((dz) => {
      while (dz.columns.length <= i) dz.columns.push({ ...EMPTY_COL });
      Object.assign(dz.columns[i], patch);
      if (!dz.columns[i].field) dz.columns.splice(i, 1);
    });

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
      <div className="qd-grid-wrap">
        <table className="qd-grid">
          <tbody>
            <tr>
              <th>Field:</th>
              {cols.map((c, i) => (
                <td key={i}>
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
                <td key={i} className="qd-static">{c.table}</td>
              ))}
            </tr>
            <tr>
              <th>Sort:</th>
              {cols.map((c, i) => (
                <td key={i}>
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
            <tr>
              <th>Show:</th>
              {cols.map((c, i) => (
                <td key={i} className="center">
                  <input type="checkbox" checked={c.show} disabled={!c.field} onChange={(e) => setCol(i, { show: e.target.checked })} />
                </td>
              ))}
            </tr>
            <tr>
              <th>Criteria:</th>
              {cols.map((c, i) => (
                <td key={i}>
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
