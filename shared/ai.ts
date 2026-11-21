/**
 * The AI assistant: what the browser sends to the server's /api/ai routes, and what comes back.
 * The model's answers are checked against these schemas before they reach the browser, which then
 * builds ordinary tables, queries and forms from them (nothing is created that you couldn't open in
 * Design View and change).
 */
import { z } from "zod";

/** Field types the assistant may choose (Image fields need pictures, so it leaves those to you). */
export const AI_FIELD_TYPES = ["AutoNumber", "ShortText", "LongText", "Number", "Currency", "DateTime", "YesNo"] as const;

/** A name: anything longer than Access allows is cut short rather than refusing the whole answer. */
const name = z.string().trim().min(1).max(300).transform((s) => s.slice(0, 64).trim());
const text = (max: number) => z.string().max(max * 4).transform((s) => s.slice(0, max));
const cell = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);

export const aiFieldSpec = z.object({
  name,
  type: z.enum(AI_FIELD_TYPES),
  /** Short Text: the most characters. */
  size: z.number().int().min(1).max(255).optional(),
  required: z.boolean().optional(),
  description: text(255).optional(),
  defaultValue: text(255).optional(),
  /** A Number field holding the key of a record in this table: becomes a relationship and a lookup. */
  references: name.optional(),
  /** A short fixed list of values (Status: Open, Closed): becomes a value-list lookup. */
  choices: z.array(text(100)).max(30).optional(),
});
export type AiFieldSpec = z.infer<typeof aiFieldSpec>;

export const aiTableSpec = z.object({
  name,
  description: text(255).optional(),
  fields: z.array(aiFieldSpec).min(1).max(40),
  /** Example records, by field name; AutoNumber keys may be left out (they count from 1 in this order). */
  sampleRows: z.array(z.record(z.string(), cell)).max(20).optional(),
});
export type AiTableSpec = z.infer<typeof aiTableSpec>;

export const aiQuerySpec = z.object({
  name,
  /** Access SQL. */
  sql: z.string().min(1).max(20_000),
  /** One or two plain sentences on what it shows. */
  explanation: text(1000),
});
export type AiQuerySpec = z.infer<typeof aiQuerySpec>;

export const aiReportSpec = z.object({
  name,
  /** A table or query in this design. */
  source: name,
  columns: z.array(name).min(1).max(20),
  groupBy: name.optional(),
  sortBy: name.optional(),
});

export const aiDatabaseSpec = z.object({
  /** A name for the database (when making a new one). */
  name,
  /** What it's for, in a sentence or two, shown before it's made. */
  summary: text(1000),
  tables: z.array(aiTableSpec).min(1).max(20),
  /** A few useful starting queries. */
  queries: z.array(aiQuerySpec).max(8).optional(),
  reports: z.array(aiReportSpec).max(6).optional(),
});
export type AiDatabaseSpec = z.infer<typeof aiDatabaseSpec>;

const turn = z.object({ prompt: z.string().max(4000), sql: z.string().max(20_000).optional(), error: z.string().max(2000).optional() });

export const aiQueryRequest = z.object({
  prompt: z.string().trim().min(1).max(4000),
  /** The database's design (tables, fields, relationships, queries) as text, from schemaForAi. */
  schema: z.string().max(60_000),
  /** Earlier requests in this conversation, with the SQL that came back and any error running it. */
  history: z.array(turn).max(8).optional(),
});
export type AiQueryRequest = z.infer<typeof aiQueryRequest>;

export const aiDatabaseRequest = z.object({
  prompt: z.string().trim().min(1).max(6000),
  /** Adding to a database: its design so far, so new tables fit in (and names don't clash). */
  schema: z.string().max(60_000).optional(),
  sampleData: z.boolean().optional(),
  /** Earlier requests in this conversation and the designs they gave (as JSON), to change them. */
  history: z.array(z.object({ prompt: z.string().max(6000), design: z.string().max(80_000).optional() })).max(6).optional(),
});
export type AiDatabaseRequest = z.infer<typeof aiDatabaseRequest>;

export interface AiStatus {
  /** The site has an AI key (otherwise the assistant's buttons are left out). */
  configured: boolean;
  /** The site has an AI key set up and this person may use it. */
  available: boolean;
  /** Why not, when it isn't. */
  reason?: string;
  /** Requests left now (today's, or the free ones left, whichever is fewer). */
  remaining?: number;
  /** The plan includes it (or the admin turned it on for them). */
  included?: boolean;
  /** Without the plan: the free requests to try it. */
  free?: { left: number; total: number; monthly: boolean };
  /** The free requests are used up: the plan is the way to go on. */
  upgrade?: boolean;
}
