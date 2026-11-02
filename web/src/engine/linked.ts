/**
 * Loads the linked tables a query uses, so local queries can join them with local tables:
 * - MySQL links: rows fetched through the server (up to LINKED_ROW_LIMIT per table);
 * - links to another database here: its table, or its query's results (run in that database).
 */
import { isAppLink, type Field, type LinkedTable, type ProjectDoc, type ProjectRecord, type TableDef } from "../../../shared/model";
import { api, ApiError } from "../api";
import { tokenize } from "./accessSql";
import { runQuery } from "./engine";
import { isActionType, queryTypeOf } from "./statements";

export const LINKED_ROW_LIMIT = 10_000;
const PAGE = 1_000;
/** Links of links (a linked query that uses another database's links) stop here. */
const MAX_DEPTH = 3;

/** Names a query mentions: bracketed or bare identifiers. */
function namesIn(sql: string): Set<string> {
  try {
    return new Set(
      tokenize(sql)
        .filter((t) => t.kind === "ident" || t.kind === "word")
        .map((t) => (t.kind === "ident" ? t.text.slice(1, -1) : t.text).toLowerCase()),
    );
  } catch {
    return new Set();
  }
}

export interface LinkedLoad {
  tables: TableDef[];
  /** e.g. "orders: only the first 10,000 of 25,000 rows were used". */
  notes: string[];
}

/**
 * A database opened through its public link can't read its linked tables: those need an account
 * with access to the MySQL connection or the other database.
 */
let publicViewing = false;
export function setPublicViewing(on: boolean) {
  publicViewing = on;
}
export const isPublicViewing = () => publicViewing;
export const PUBLIC_LINK_MESSAGE = "Linked tables aren't available in a public view of this database.";
function checkPublic(name: string) {
  if (publicViewing) throw new Error(`'${name}': ${PUBLIC_LINK_MESSAGE}`);
}

/** Source databases fetched during one load, so each is read once. */
export type SourceCache = Map<string, Promise<ProjectRecord>>;

function fetchSource(projectId: string, cache: SourceCache): Promise<ProjectRecord> {
  let p = cache.get(projectId);
  if (!p) {
    p = api.getProject(projectId).then((r) => r.project);
    cache.set(projectId, p);
  }
  return p;
}

export interface AppLinkData {
  table: TableDef;
  project: ProjectRecord;
  objectName: string;
  notes: string[];
}

/** Reads a link to a table or query in another database here, as a table. */
export async function loadAppLink(link: LinkedTable, cache: SourceCache = new Map(), depth = 0): Promise<AppLinkData> {
  if (!isAppLink(link)) throw new Error("This isn't a link to another database.");
  checkPublic(link.name);
  const from = link.sourceProjectName ? `'${link.sourceProjectName}'` : "its source database";
  let project: ProjectRecord;
  try {
    project = await fetchSource(link.sourceProject, cache);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      throw new Error(`You can't open ${from} any more: it was deleted, or it's no longer shared with you. Delete the link, or ask its owner to share it again.`);
    }
    throw e;
  }
  const doc = project.doc;
  if (link.sourceKind === "table") {
    const t = doc.tables.find((x) => x.id === link.sourceId);
    if (!t) throw new Error(`The table '${link.sourceName ?? "?"}' isn't in '${project.name}' any more. Delete the link and link it again.`);
    return { table: { ...t, id: link.id, name: link.name }, project, objectName: t.name, notes: [] };
  }
  const q = doc.queries.find((x) => x.id === link.sourceId);
  if (!q) throw new Error(`The query '${link.sourceName ?? "?"}' isn't in '${project.name}' any more. Delete the link and link it again.`);
  if (isActionType(q.mode === "design" && q.design?.type ? q.design.type : queryTypeOf(q.sql))) throw new Error(`'${q.name}' in '${project.name}' is an action query; only select queries can be linked.`);
  if (depth >= MAX_DEPTH) throw new Error(`'${q.name}' uses links nested too deeply (or a link that points back to itself).`);
  const nested = await loadLinkedTables(doc, project.id, q.sql, cache, depth + 1);
  let r;
  try {
    r = await runQuery(doc, q.sql, { excludeQueryId: q.id, extraTables: nested.tables });
  } catch (e) {
    throw new Error(`The query '${q.name}' in '${project.name}' couldn't run: ${(e as Error).message}`);
  }
  const fields: Field[] = r.columns.map((c, i) => ({ ...(r.fields[i] ?? { type: "ShortText" }), id: `c${i}`, name: c, primaryKey: false }) as Field);
  return {
    table: {
      id: link.id,
      name: link.name,
      fields,
      rows: r.rows.map((row, i) => Object.fromEntries([["_id", `${link.id}:${i}`], ...fields.map((f, c) => [f.id, row[c] ?? null])])),
      nextAutoNumber: 1,
    },
    project,
    objectName: q.name,
    notes: nested.notes,
  };
}

async function loadMySqlLink(link: LinkedTable, projectId: string, notes: string[]): Promise<TableDef> {
  checkPublic(link.name);
  const cid = link.connectionId!;
  const remote = link.remoteTable!;
  const first = await api.remoteRows(projectId, cid, remote, 0, PAGE);
  const rows = [...first.rows];
  while (rows.length < LINKED_ROW_LIMIT && first.total !== null && rows.length < first.total) {
    const next = await api.remoteRows(projectId, cid, remote, rows.length, PAGE);
    if (!next.rows.length) break;
    rows.push(...next.rows);
  }
  if (first.total !== null && first.total > rows.length) {
    notes.push(`${link.name}: only the first ${rows.length.toLocaleString()} of ${first.total.toLocaleString()} rows were used.`);
  }
  const fields: Field[] = first.fields.map((f, i) => ({ ...(f ?? { type: "ShortText" }), id: `c${i}`, name: first.columns[i] }) as Field);
  return {
    id: link.id,
    name: link.name,
    fields,
    rows: rows.map((r, i) => Object.fromEntries([["_id", `${link.id}:${i}`], ...fields.map((f, c) => [f.id, r[c] ?? null])])),
    nextAutoNumber: 1,
  };
}

export async function loadLinkedTables(doc: ProjectDoc, projectId: string, sql: string, cache: SourceCache = new Map(), depth = 0): Promise<LinkedLoad> {
  const links = doc.linkedTables ?? [];
  if (!links.length) return { tables: [], notes: [] };
  // The query itself, plus saved queries it uses (they may use linked tables too).
  const names = namesIn(sql);
  for (let grew = true; grew; ) {
    grew = false;
    for (const q of doc.queries) {
      if (!names.has(q.name.toLowerCase())) continue;
      for (const n of namesIn(q.sql)) if (!names.has(n)) (names.add(n), (grew = true));
    }
  }
  const used = links.filter((l) => names.has(l.name.toLowerCase()));
  const notes: string[] = [];
  const tables = await Promise.all(
    used.map(async (link): Promise<TableDef> => {
      if (!isAppLink(link)) return loadMySqlLink(link, projectId, notes);
      try {
        const data = await loadAppLink(link, cache, depth);
        notes.push(...data.notes);
        return data.table;
      } catch (e) {
        throw new Error(`Linked table '${link.name}': ${(e as Error).message}`);
      }
    }),
  );
  return { tables, notes };
}
