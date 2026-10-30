/**
 * Loads the linked MySQL tables a query uses, so local queries can join them with local
 * tables. Rows are fetched through the server (up to LINKED_ROW_LIMIT per table).
 */
import type { Field, ProjectDoc, TableDef } from "../../../shared/model";
import { api } from "../api";
import { tokenize } from "./accessSql";

export const LINKED_ROW_LIMIT = 10_000;
const PAGE = 1_000;

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

export async function loadLinkedTables(doc: ProjectDoc, projectId: string, sql: string): Promise<LinkedLoad> {
  const links = doc.linkedTables ?? [];
  if (!links.length) return { tables: [], notes: [] };
  // The query itself, plus saved queries it uses (they may use linked tables too).
  const names = namesIn(sql);
  for (const q of doc.queries) if (names.has(q.name.toLowerCase())) for (const n of namesIn(q.sql)) names.add(n);
  const used = links.filter((l) => names.has(l.name.toLowerCase()));
  const notes: string[] = [];
  const tables = await Promise.all(
    used.map(async (link): Promise<TableDef> => {
      const first = await api.remoteRows(projectId, link.connectionId, link.remoteTable, 0, PAGE);
      const rows = [...first.rows];
      while (rows.length < LINKED_ROW_LIMIT && first.total !== null && rows.length < first.total) {
        const next = await api.remoteRows(projectId, link.connectionId, link.remoteTable, rows.length, PAGE);
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
    }),
  );
  return { tables, notes };
}
