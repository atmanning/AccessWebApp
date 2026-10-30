import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CellValue, ConnectionInfo, Field, LinkedTable, RemoteRows, SqlRunResult } from "../../../shared/model";
import { api } from "../api";
import { ComboBox } from "../ui/ComboBox";
import { useCommands, useWorkspace } from "../workspace/context";
import { exportCsv } from "../workspace/csv";
import { Datasheet, type DatasheetHandle } from "./Datasheet";

const PAGE = 500;

/** A linked MySQL table: read-only datasheet, loaded a page at a time. */
export function LinkedTableView({ link, tabKey }: { link: LinkedTable; tabKey: string }) {
  const ws = useWorkspace();
  const [page, setPage] = useState<RemoteRows | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const grid = useRef<DatasheetHandle>(null);
  const connection = ws.connections?.find((c) => c.id === link.connectionId);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.remoteRows(ws.projectId, link.connectionId, link.remoteTable, offset, PAGE).then(
      (r) => {
        if (cancelled) return;
        setPage(r);
        setError(null);
        const end = r.offset + r.rows.length;
        ws.setStatus(
          `Linked table ${link.remoteTable} on ${connection?.name ?? "MySQL"}: records ${r.rows.length ? r.offset + 1 : 0}–${end}` +
            `${r.total !== null ? ` of ${r.total.toLocaleString()}` : ""}${r.skipped.length ? `. Not shown: ${r.skipped.join(", ")} (binary data)` : ""}.`,
        );
      },
      (e) => !cancelled && (setError((e as Error).message), setPage(null)),
    ).finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [link.connectionId, link.remoteTable, offset, reload, ws.projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const columns = useMemo(
    () =>
      (page?.fields ?? []).map((f, i) => ({
        key: `${i}:${page!.columns[i]}`,
        label: page!.columns[i],
        field: f ?? undefined,
        readOnly: true,
        readOnlyReason: "Linked MySQL tables are read-only here. Use the SQL Console to change data, or import the table.",
      })),
    [page],
  );
  const getValue = useCallback((r: number, c: number) => page?.rows[r]?.[c] ?? null, [page]);

  useCommands(tabKey, {
    sortAsc: () => grid.current?.sort("ASC"),
    sortDesc: () => grid.current?.sort("DESC"),
    removeSort: () => grid.current?.sort(null),
    find: () => grid.current?.focusFind(),
    exportText: () => page && exportCsv(link.name, page.columns, page.rows, page.fields.map((f) => f ?? undefined)),
  });

  if (!connection && ws.connections) {
    return (
      <div className="query-error">
        <strong>This linked table's connection is missing.</strong>
        <p>The connection it used was deleted, or this database was copied without its connections. Delete the link, or create the connection again and re-link the table.</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="query-error">
        <strong>Couldn't read {link.remoteTable} from {connection?.name ?? "MySQL"}.</strong>
        <pre className="test-result error">{error}</pre>
        <button onClick={() => setReload((n) => n + 1)}>Try again</button>
      </div>
    );
  }
  if (!page) return <div className="empty-view">{loading ? "Loading from MySQL…" : ""}</div>;
  const total = page.total;
  return (
    <div className="linked-view">
      <div className="linked-bar">
        <span>
          <strong>{link.remoteTable}</strong> on {connection?.name} ·{" "}
          {page.rows.length ? `records ${page.offset + 1}–${page.offset + page.rows.length}` : "no records"}
          {total !== null && ` of ${total.toLocaleString()}`}
        </span>
        <span className="spacer" />
        <button disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>◀ Previous {PAGE}</button>
        <button disabled={loading || (total !== null ? offset + PAGE >= total : page.rows.length < PAGE)} onClick={() => setOffset(offset + PAGE)}>
          Next {PAGE} ▶
        </button>
        <button disabled={loading} onClick={() => setReload((n) => n + 1)} title="Reload from the server">Refresh</button>
      </div>
      <Datasheet
        key={`${offset}:${reload}`}
        ref={grid}
        columns={columns}
        rowCount={page.rows.length}
        getValue={getValue}
        rowKey={(r) => String(page.offset + r)}
        editable={false}
        emptyMessage="This table has no records."
        onStatus={ws.setStatus}
      />
    </div>
  );
}

interface ConsoleEntry {
  sql: string;
  result: SqlRunResult;
  at: Date;
}

const secs = (ms: number) => `(${(ms / 1000).toFixed(2)} sec)`;

/** The text the mysql command-line client would print for a result. */
export function cliText(r: SqlRunResult): string {
  if (r.kind === "error") return `ERROR${r.errno !== null ? ` ${r.errno}` : ""}${r.sqlState ? ` (${r.sqlState})` : ""}: ${r.message}`;
  if (r.kind === "ok") {
    const lines = [`Query OK, ${r.affectedRows} row${r.affectedRows === 1 ? "" : "s"} affected${r.warnings ? `, ${r.warnings} warning${r.warnings === 1 ? "" : "s"}` : ""} ${secs(r.elapsedMs)}`];
    if (r.info) lines.push(r.info.trim().replace(/\s{2,}/g, "  "));
    if (r.insertId) lines.push(`Last insert id: ${r.insertId}`);
    return lines.join("\n");
  }
  const n = r.rows.length;
  if (!n) return `Empty set ${secs(r.elapsedMs)}`;
  // A small result also prints as the familiar ASCII table.
  if (n <= 20 && r.columns.length <= 12) {
    const show = (v: CellValue) => (v === null ? "NULL" : typeof v === "boolean" ? (v ? "1" : "0") : String(v).replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/, "$1 $2"));
    const widths = r.columns.map((c, i) => Math.min(40, Math.max(c.length, ...r.rows.map((row) => show(row[i]).length))));
    const cut = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + "…" : s);
    const line = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
    const row = (cells: string[]) => "| " + cells.map((c, i) => cut(c, widths[i]).padEnd(widths[i])).join(" | ") + " |";
    return [line, row(r.columns), line, ...r.rows.map((x) => row(x.map(show))), line, `${n} row${n === 1 ? "" : "s"} in set ${secs(r.elapsedMs)}`].join("\n");
  }
  return `${n.toLocaleString()} rows in set ${secs(r.elapsedMs)}${r.truncated ? " — showing the first 5,000" : ""}`;
}

/** SQL console for a MySQL connection: run one statement at a time, see mysql-style output and a grid. */
export function SqlConsoleView({ connectionId, tabKey }: { connectionId: string; tabKey: string }) {
  const ws = useWorkspace();
  const [cid, setCid] = useState(connectionId);
  const [sql, setSql] = useState("");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<ConsoleEntry[]>([]);
  const [grid, setGrid] = useState<Extract<SqlRunResult, { kind: "rows" }> | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [histPos, setHistPos] = useState(-1);
  const out = useRef<HTMLDivElement>(null);
  const connection: ConnectionInfo | undefined = ws.connections?.find((c) => c.id === cid);

  useEffect(() => {
    out.current?.scrollTo({ top: out.current.scrollHeight });
  }, [log]);

  const run = async () => {
    // Run the selection if there is one, else the whole box (one statement).
    const box = document.getElementById(`console-${tabKey}`) as HTMLTextAreaElement | null;
    const selected = box && box.selectionEnd > box.selectionStart ? sql.slice(box.selectionStart, box.selectionEnd) : sql;
    const statement = selected.trim().replace(/;\s*$/, "");
    if (!statement || !cid || running) return;
    setRunning(true);
    try {
      const result = await api.runRemoteSql(ws.projectId, cid, statement);
      setLog((l) => [...l.slice(-199), { sql: statement, result, at: new Date() }]);
      if (result.kind === "rows") setGrid(result);
      ws.setStatus(result.kind === "error" ? "The statement failed; see the output." : cliText(result).split("\n").pop()!, result.kind === "error" ? "error" : "info");
    } catch (e) {
      const result: SqlRunResult = { kind: "error", errno: null, sqlState: null, code: null, message: (e as Error).message, elapsedMs: 0 };
      setLog((l) => [...l, { sql: statement, result, at: new Date() }]);
    } finally {
      setRunning(false);
      setHistory((h) => [statement, ...h.filter((x) => x !== statement)].slice(0, 50));
      setHistPos(-1);
    }
  };

  useCommands(tabKey, { run: () => void run() });

  const columns = useMemo(
    () => (grid?.columns ?? []).map((c, i) => ({ key: `${i}:${c}`, label: c, field: (grid?.fields[i] as Field | null) ?? undefined, readOnly: true })),
    [grid],
  );
  const getValue = useCallback((r: number, c: number) => grid?.rows[r]?.[c] ?? null, [grid]);

  if (ws.readOnly) return <div className="query-error"><strong>The SQL console needs edit access.</strong><p>Ask the owner for edit access to run SQL on this database's connections.</p></div>;

  return (
    <div className="console-view">
      <div className="console-top">
        <label className="conn-pick inline">
          Connection
          <ComboBox
            className="text-input"
            value={cid}
            ariaLabel="Connection"
            options={(ws.connections ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.user}@${c.host}${c.database ? `/${c.database}` : ""})` }))}
            onChange={setCid}
          />
        </label>
        <button className="primary" disabled={running || !sql.trim() || !connection} onClick={() => void run()}>
          {running ? "Running…" : "▶ Run"}
        </button>
        <button onClick={() => setLog([])} disabled={!log.length}>Clear output</button>
      </div>
      <textarea
        id={`console-${tabKey}`}
        className="sql-editor console-editor"
        value={sql}
        spellCheck={false}
        placeholder="Type one MySQL statement, e.g. SELECT * FROM customers LIMIT 10   (Ctrl+Enter runs it; Ctrl+↑/↓ recalls earlier ones)"
        aria-label="MySQL statement"
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            void run();
          } else if ((e.ctrlKey || e.metaKey) && (e.key === "ArrowUp" || e.key === "ArrowDown") && history.length) {
            e.preventDefault();
            const next = Math.max(-1, Math.min(history.length - 1, histPos + (e.key === "ArrowUp" ? 1 : -1)));
            setHistPos(next);
            setSql(next < 0 ? "" : history[next]);
          }
        }}
      />
      <div className="console-split">
        <div className="console-output" ref={out} aria-live="polite">
          {!log.length && <div className="muted">Output appears here, as the mysql command-line client prints it.</div>}
          {log.map((entry, i) => (
            <div key={i} className={`console-entry ${entry.result.kind}`}>
              <div className="console-prompt">mysql&gt; {entry.sql}</div>
              <pre>{cliText(entry.result)}</pre>
            </div>
          ))}
        </div>
        <div className="console-grid">
          {grid ? (
            <Datasheet columns={columns} rowCount={grid.rows.length} getValue={getValue} rowKey={(r) => String(r)} editable={false} emptyMessage="Empty set." onStatus={ws.setStatus} key={grid.elapsedMs + ":" + grid.rows.length + ":" + grid.columns.join()} />
          ) : (
            <div className="empty-view">Results of SELECT statements show here as a datasheet.</div>
          )}
        </div>
      </div>
    </div>
  );
}
