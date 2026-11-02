/**
 * Opening a query that was written in SQL View in Design View: reads the SQL into the grid
 * (engine/sqlToDesign.ts), then checks that the SQL the grid would write returns the same
 * records as the original before showing it, so Design View never quietly changes a query.
 */
import type { ProjectDoc, QueryDef } from "../../../shared/model";
import { api } from "../api";
import { runQuery } from "../engine/engine";
import { isPublicViewing, loadAppLink, loadLinkedTables, PUBLIC_LINK_MESSAGE } from "../engine/linked";
import { tokenize } from "../engine/accessSql";
import { designSql, type QueryDesign } from "../engine/queryDesign";
import { sqlToDesign } from "../engine/sqlToDesign";

export type SqlReadState =
  | { status: "reading" }
  | { status: "ok"; design: QueryDesign; note?: string }
  | { status: "failed"; reason: string };

export interface SourceField {
  id: string;
  name: string;
  primaryKey?: boolean;
}

const fieldCache = new Map<string, Promise<SourceField[]>>();

/** Field names of a linked table or a saved query, read from its source (cached per session). */
export function sourceFieldNames(doc: ProjectDoc, projectId: string, name: string): Promise<SourceField[]> | null {
  const n = name.toLowerCase();
  const link = doc.linkedTables?.find((l) => l.name.toLowerCase() === n);
  const query = !link ? doc.queries.find((q) => q.name.toLowerCase() === n) : undefined;
  if (!link && !query) return null;
  const key = link ? `${projectId}:link:${link.id}:${link.remoteTable ?? link.sourceId}` : `${projectId}:query:${query!.id}:${query!.sql}`;
  let p = fieldCache.get(key);
  if (!p) {
    if (link) {
      p = isPublicViewing()
        ? Promise.reject(new Error(PUBLIC_LINK_MESSAGE))
        : link.connectionId && link.remoteTable
          ? api.remoteRows(projectId, link.connectionId, link.remoteTable, 0, 1).then((r) => r.columns.map((col, i) => ({ id: `c${i}`, name: col })))
          : loadAppLink(link).then((d) => d.table.fields.map((f) => ({ id: f.id, name: f.name })));
    } else {
      const q = query!;
      p = loadLinkedTables(doc, projectId, q.sql)
        .then(({ tables }) => runQuery(doc, q.sql, { maxRows: 1, excludeQueryId: q.id, extraTables: tables }))
        .then((r) => r.columns.map((col, i) => ({ id: `q${i}`, name: col })));
    }
    p.catch(() => fieldCache.delete(key)); // try again next time
    fieldCache.set(key, p);
  }
  return p;
}

const canon = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();

export async function readSqlDesign(doc: ProjectDoc, projectId: string, query: QueryDef): Promise<SqlReadState> {
  try {
    // Field names of the linked tables and queries the SQL uses, so [Field] can be matched to its source.
    const sourceFields = new Map<string, string[]>();
    const names = new Set(
      tokenize(query.sql)
        .filter((t) => t.kind === "ident" || t.kind === "word")
        .map((t) => (t.kind === "ident" ? t.text.slice(1, -1) : t.text).toLowerCase()),
    );
    for (const n of names) {
      if (doc.tables.some((t) => t.name.toLowerCase() === n)) continue;
      const fields = sourceFieldNames(doc, projectId, n);
      if (fields) sourceFields.set(n, (await fields.catch(() => [])).map((f) => f.name));
    }

    const linked = await loadLinkedTables(doc, projectId, query.sql).catch(() => ({ tables: [] }));
    const run = (sql: string) => runQuery(doc, sql, { excludeQueryId: query.id, extraTables: linked.tables });
    let original: Awaited<ReturnType<typeof run>> | null = null;
    let runError = "";
    try {
      original = await run(query.sql);
    } catch (e) {
      runError = (e as Error).message;
    }
    const parsed = sqlToDesign(doc, query.sql, { sourceFields, outputNames: original?.columns });
    if (!parsed.ok) return { status: "failed", reason: parsed.reason };
    if (!original) {
      return { status: "ok", design: parsed.design, note: `The SQL doesn't run (${runError}), so Design View couldn't check it against the results.` };
    }
    const regenerated = designSql(doc, parsed.design);
    let again: Awaited<ReturnType<typeof run>>;
    try {
      again = await run(regenerated);
    } catch (e) {
      return { status: "failed", reason: `Design View couldn't rebuild this query (${(e as Error).message}).` };
    }
    const sameColumns = again.columns.length === original.columns.length;
    const sameRows = sameColumns && JSON.stringify(canon(again.rows)) === JSON.stringify(canon(original.rows));
    if (!sameRows) {
      console.warn("Design View: rebuilt SQL differs", { original: query.sql, regenerated });
      return { status: "failed", reason: "Design View would change what this query returns, so it stays in SQL View." };
    }
    const renamed = original.columns.flatMap((c, i) => (again.columns[i] !== c ? [`'${c}' → '${again.columns[i]}'`] : []));
    return {
      status: "ok",
      design: parsed.design,
      ...(renamed.length ? { note: `Column names that Design View can't keep: ${renamed.join(", ")}.` } : {}),
    };
  } catch (e) {
    return { status: "failed", reason: (e as Error).message };
  }
}
