/**
 * Create > Describe a Query: say what you want to see in plain words; the AI assistant writes the
 * query, it's tried on your data at once, and you save it as an ordinary query (in Design View when
 * it fits there) or ask for a change.
 */
import { useEffect, useRef, useState } from "react";
import type { AiQuerySpec } from "../../../shared/ai";
import { formatValue } from "../../../shared/values";
import { api } from "../api";
import { runQuery, type ResultSet } from "../engine/engine";
import { sqlToDesign } from "../engine/sqlToDesign";
import { Modal } from "../ui/dialogs";
import { useWorkspace } from "../workspace/context";
import { newId, uniqueObjectName, validateObjectName } from "../workspace/docOps";
import { schemaForAi } from "./schemaForAi";

interface Turn {
  prompt: string;
  sql?: string;
  error?: string;
}

const EXAMPLES = ["Customers who haven't ordered in the last 90 days", "Total sales by month this year", "The 10 most expensive products, with their category"];

export function AskQueryDialog({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Turn[]>([]);
  const [query, setQuery] = useState<AiQuerySpec | null>(null);
  const [name, setName] = useState("");
  const [result, setResult] = useState<ResultSet | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const examples = ws.doc.tables.length ? EXAMPLES : [];

  useEffect(() => {
    api.aiStatus().then((s) => {
      if (!s.available) setError(s.reason ?? "The AI assistant isn't available.");
      if (s.remaining !== undefined) setRemaining(s.remaining);
    }, () => undefined);
  }, []);

  const tryRun = async (sql: string): Promise<string | null> => {
    try {
      setResult(await runQuery(ws.getDoc(), sql, { maxRows: 200 }));
      setRunError(null);
      return null;
    } catch (e) {
      setResult(null);
      return (e as Error).message;
    }
  };

  const ask = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      let turns = history;
      let ask = text;
      // One more go when the query doesn't run, with the error, as a person would.
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await api.aiQuery({ prompt: ask, schema: schemaForAi(ws.getDoc()), history: turns });
        setRemaining(r.remaining);
        const failed = await tryRun(r.query.sql);
        turns = [...turns, { prompt: ask, sql: r.query.sql, ...(failed ? { error: failed } : {}) }];
        setQuery(r.query);
        setName(uniqueObjectName(ws.getDoc(), "query", r.query.name));
        if (!failed) break;
        setRunError(failed);
        ask = "Please fix the query so it runs.";
      }
      setHistory(turns);
      setPrompt("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  };

  const save = () => {
    if (!query) return;
    const bad = validateObjectName(ws.getDoc(), "query", name.trim());
    if (bad) return setError(bad);
    const id = newId("q");
    const design = sqlToDesign(ws.getDoc(), query.sql);
    ws.update((d) => {
      d.queries.push(design.ok ? { id, name: name.trim(), mode: "design", sql: query.sql, design: design.design } : { id, name: name.trim(), mode: "sql", sql: query.sql });
    });
    ws.openObject("query", id);
    ws.setStatus(`Saved the query ${name.trim()}. Switch to Design View to change it.`);
    onClose();
  };

  return (
    <Modal
      title="Describe a Query"
      onClose={onClose}
      width={860}
      footer={
        <>
          {query && (
            <button className="primary" onClick={save} disabled={busy || !!runError}>
              Save Query
            </button>
          )}
          <button onClick={onClose}>{query ? "Cancel" : "Close"}</button>
        </>
      }
    >
      <div className="ai-dialog">
        <label className="ai-label" htmlFor="ai-query-prompt">
          {query ? "Want it different? Say what to change:" : "What do you want to see?"}
        </label>
        <div className="ai-ask">
          <textarea
            id="ai-query-prompt"
            ref={box}
            className="text-input"
            rows={query ? 2 : 3}
            value={prompt}
            autoFocus
            placeholder={query ? "e.g. only customers in Texas, newest first" : "e.g. customers who haven't ordered since June, with their phone numbers"}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey || !e.shiftKey)) {
                e.preventDefault();
                ask();
              }
            }}
          />
          <button className="primary" onClick={ask} disabled={busy || !prompt.trim()}>
            {busy ? "Working…" : query ? "Change" : "Build Query"}
          </button>
        </div>
        {!query && examples.length > 0 && (
          <div className="ai-examples">
            {examples.map((x) => (
              <button key={x} type="button" onClick={() => setPrompt(x)}>
                {x}
              </button>
            ))}
          </div>
        )}
        {error && <div className="ai-error" role="alert">{error}</div>}
        {query && (
          <div className="ai-result">
            <div className="ai-explain">{query.explanation}</div>
            {runError && <div className="ai-error" role="alert">This query doesn't run yet: {runError} Try saying what you want another way.</div>}
            {result && (
              <>
                <div className="ai-preview-head">
                  {result.rows.length === 200 ? "First 200 records" : `${result.rows.length} record${result.rows.length === 1 ? "" : "s"}`}
                </div>
                <div className="ai-preview">
                  <table className="datasheet">
                    <thead>
                      <tr>{result.columns.map((c, i) => <th key={i}>{c}</th>)}</tr>
                    </thead>
                    <tbody>
                      {result.rows.slice(0, 50).map((r, ri) => (
                        <tr key={ri}>{r.map((v, ci) => <td key={ci}>{formatValue(result.fields[ci], v)}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <details className="ai-sql">
              <summary>SQL</summary>
              <pre>{query.sql}</pre>
            </details>
            <label className="ai-name">
              Query name <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          </div>
        )}
        <p className="small muted ai-privacy">
          Your request and this database's design (table and field names, and the values of short lists) go to Claude, Anthropic's AI, to write the query. Other records stay here.
          {remaining !== null && ` ${remaining} AI request${remaining === 1 ? "" : "s"} left today.`}
        </p>
      </div>
    </Modal>
  );
}
