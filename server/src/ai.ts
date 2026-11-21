/**
 * /api/ai — the AI assistant: describe a query or a database in plain words, get back a design the
 * browser builds into ordinary objects. Uses Anthropic's Messages API with a forced tool call, so the
 * answer is structured; it's then checked against the shared schemas.
 *
 * Off unless ANTHROPIC_API_KEY is set. Each person gets AI_DAILY_LIMIT requests a day (default 50);
 * with "Require a plan" on, the assistant is an Advanced feature like the others.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { DB } from "./db.js";
import { requireUser } from "./auth.js";
import type { Plans } from "./plans.js";
import {
  aiDatabaseRequest,
  aiDatabaseSpec,
  aiQueryRequest,
  aiQuerySpec,
  type AiStatus,
} from "../../shared/ai.js";

export interface AiOptions {
  apiKey: string | null;
  model: string;
  /** The API's address (default https://api.anthropic.com). */
  baseUrl?: string;
  dailyLimit: number;
  /** For tests. */
  fetchImpl?: typeof fetch;
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

const today = () => new Date().toISOString().slice(0, 10);

const ACCESS_SQL = `Write Microsoft Access SQL as Access itself would run it:
- Put table and field names in [brackets]. Text values in "double quotes". Dates as #2026-01-31#. Yes/No fields compare to True / False.
- Wildcards in LIKE are * and ? (LIKE "Sm*"). Join text with &.
- Functions available: IIf, Nz, IsNull, Date(), Now(), Year, Month, Day, DateAdd("m", -1, Date()), DateDiff("d", a, b), DateSerial, Format, Left, Right, Mid, Len, InStr, Trim, UCase, LCase, Round, Int, Val, CLng, CDbl, CStr.
- Aggregates: Count, Sum, Avg, Min, Max, First, Last with GROUP BY; HAVING for conditions on them. Use TOP n for "top/first n".
- Joins: INNER JOIN / LEFT JOIN ... ON; with three or more tables, nest them in parentheses as Access does: FROM ([A] INNER JOIN [B] ON ...) INNER JOIN [C] ON ...
- Crosstabs: TRANSFORM Sum([X]) SELECT [Row] FROM ... GROUP BY [Row] PIVOT [Column].
- Give calculated columns a readable alias: ... AS [Total Sales]. Only use tables, queries and fields that exist in the design given.
- A saved query can be used like a table by its name.`;

const QUERY_SYSTEM = `You build queries for Access Web, a web version of Microsoft Access, for people who aren't programmers.
Given the database design and a request in plain words, write one SELECT query (or a crosstab) that answers it. Never write queries that change data (no UPDATE, DELETE, INSERT, SELECT INTO, DROP, ALTER).
${ACCESS_SQL}
Name the query in a few words, Access style (e.g. "Customers Without Orders Since June"). Explain in one or two plain sentences what it shows, mentioning any assumption you made about what was meant.
If a previous attempt failed with an error, fix it. If the request is a change to the previous query, change that query.`;

const DATABASE_SYSTEM = `You design databases for Access Web, a web version of Microsoft Access, for people who aren't programmers.
From a description in plain words, design a small, sensible relational database:
- Tables named in plain words, usually plural (Customers, Orders, Order Items). Field names readable, without spaces where Access users usually skip them is fine either way; be consistent.
- Every table's first field is its AutoNumber key, named after the table in singular + "ID" (CustomerID).
- A field that points to another table is a Number field with the same name as that table's key and "references" set to that table's name (Orders.CustomerID references Customers). This makes the relationship and a drop-down.
- Use "choices" for short fixed lists (Status: Open, In Progress, Done). Use Currency for money, DateTime for dates, YesNo for yes/no, LongText for notes, ShortText (with a size) for other text.
- Mark fields people must fill in as required. Keep it to what was asked; 1 to 8 tables is typical.
- Put tables that others refer to before the tables that refer to them.
- Add up to five useful starter queries for what the person will want to see (overdue items, totals by month, etc.), and up to three reports (a source table or query, the columns to show, optionally a field to group by).
${ACCESS_SQL}
When asked for sample records, give 5 to 10 realistic, made-up example records per table (fewer for lookup tables), using plausible names and recent dates; foreign keys use the referenced table's records' numbers in order, counting from 1. Without that request, leave sampleRows out.
When the existing design is given, add to it: don't repeat its tables (refer to them by name instead), and choose new names that don't clash.`;

/** One forced tool call; returns the tool's input. */
async function callTool<T>(opts: AiOptions, args: { system: string; messages: { role: "user" | "assistant"; content: string }[]; tool: string; description: string; schema: z.ZodType<T>; maxTokens: number }): Promise<T> {
  if (!opts.apiKey) throw new AiError("The AI assistant isn't set up on this site.", 503);
  const doFetch = opts.fetchImpl ?? fetch;
  const inputSchema = z.toJSONSchema(args.schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  delete inputSchema.$schema;
  let res: globalThis.Response;
  try {
    res = await doFetch(`${(opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: args.maxTokens,
        system: args.system,
        messages: args.messages,
        tools: [{ name: args.tool, description: args.description, input_schema: inputSchema }],
        tool_choice: { type: "tool", name: args.tool },
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    throw new AiError(`The AI service couldn't be reached (${(e as Error).message}). Please try again.`);
  }
  const body = (await res.json().catch(() => null)) as { content?: { type: string; name?: string; input?: unknown }[]; error?: { type?: string; message?: string }; stop_reason?: string } | null;
  if (!res.ok) {
    const kind = body?.error?.type ?? "";
    if (res.status === 429 || kind === "rate_limit_error" || kind === "overloaded_error") throw new AiError("The AI service is busy right now. Please try again in a minute.", 503);
    if (res.status === 401 || res.status === 403) throw new AiError("The AI assistant's key isn't working. Please tell the site's administrator.", 503);
    throw new AiError(`The AI service refused the request: ${body?.error?.message ?? res.statusText}`);
  }
  const call = body?.content?.find((c) => c.type === "tool_use" && c.name === args.tool);
  if (!call) throw new AiError("The AI didn't give an answer this time. Please try again or put it another way.");
  const parsed = args.schema.safeParse(call.input);
  if (!parsed.success) {
    if (body?.stop_reason === "max_tokens") throw new AiError("That's a lot to build in one go. Try describing fewer tables, or leave out the sample records.");
    throw new AiError("The AI's answer didn't fit together. Please try again or put it another way.");
  }
  return parsed.data;
}

export function aiRouter(db: DB, plans: Plans, opts: AiOptions) {
  const router = Router();
  const used = db.prepare("SELECT count FROM ai_usage WHERE user_id = ? AND day = ?");
  const bump = db.prepare("INSERT INTO ai_usage (user_id, day, count) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1");
  const clean = db.prepare("DELETE FROM ai_usage WHERE day < ?");
  const remaining = (userId: string) => Math.max(0, opts.dailyLimit - (((used.get(userId, today()) as { count: number } | undefined)?.count) ?? 0));

  const status = (req: Request): AiStatus => {
    if (!opts.apiKey) return { configured: false, available: false, reason: "The AI assistant isn't set up on this site (the administrator adds an Anthropic API key)." };
    if (!plans.has(req.user!.id, "ai")) return { configured: true, available: false, reason: "The AI assistant is part of the Advanced plan." };
    const left = remaining(req.user!.id);
    if (left <= 0) return { configured: true, available: false, reason: `You've used today's ${opts.dailyLimit} AI requests. They start again tomorrow.`, remaining: 0 };
    return { configured: true, available: true, remaining: left };
  };

  /** Checks they may ask, counts the request, and answers with the result or a plain error. */
  const handle = (run: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
    const s = status(req);
    if (!s.available) return res.status(opts.apiKey ? 402 : 503).json({ error: s.reason, code: opts.apiKey && s.remaining !== 0 ? "upgrade" : undefined });
    bump.run(req.user!.id, today());
    if (Math.random() < 0.02) clean.run(new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10));
    try {
      res.json({ ...(await run(req)) as object, remaining: remaining(req.user!.id) });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: "That request is too long or incomplete." });
      if (e instanceof AiError) return res.status(e.status).json({ error: e.message });
      console.error("AI request failed", e);
      res.status(500).json({ error: "Something went wrong with the AI request. Please try again." });
    }
  };

  router.use(requireUser);
  router.get("/status", (req, res) => void res.json(status(req)));

  router.post(
    "/query",
    handle(async (req) => {
      const r = aiQueryRequest.parse(req.body);
      const messages: { role: "user" | "assistant"; content: string }[] = [];
      const first = (prompt: string) => `Database design:\n${r.schema}\n\nRequest: ${prompt}`;
      (r.history ?? []).forEach((h, i) => {
        messages.push({ role: "user", content: i === 0 ? first(h.prompt) : h.prompt });
        messages.push({ role: "assistant", content: h.sql ? `Query:\n${h.sql}` : "(no query)" });
        if (h.error) messages.push({ role: "user", content: `Running that query failed: ${h.error}` }, { role: "assistant", content: "I'll take that into account." });
      });
      messages.push({ role: "user", content: messages.length ? r.prompt : first(r.prompt) });
      const query = await callTool(opts, { system: QUERY_SYSTEM, messages, tool: "make_query", description: "The query that answers the request.", schema: aiQuerySpec, maxTokens: 3000 });
      if (/^\s*(update|delete|insert|drop|alter|create)\b/i.test(query.sql) || /\binto\s+\[/i.test(query.sql.split(/\bfrom\b/i)[0])) {
        throw new AiError("The AI wrote a query that would change data, which it isn't allowed to do here. Try asking for what you want to see.");
      }
      return { query };
    }),
  );

  router.post(
    "/database",
    handle(async (req) => {
      const r = aiDatabaseRequest.parse(req.body);
      const ask = (prompt: string) =>
        [r.schema ? `Existing design:\n${r.schema}\n` : "", `Description: ${prompt}`, r.sampleData ? "Include sample records." : "No sample records."].filter(Boolean).join("\n");
      const messages: { role: "user" | "assistant"; content: string }[] = [];
      for (const h of r.history ?? []) messages.push({ role: "user", content: messages.length ? h.prompt : ask(h.prompt) }, { role: "assistant", content: h.design ? `Design:\n${h.design}` : "(design made)" });
      messages.push({ role: "user", content: messages.length ? `Make the design again with this change: ${r.prompt}\n${r.sampleData ? "Include sample records." : "No sample records."}` : ask(r.prompt) });
      const design = await callTool(opts, { system: DATABASE_SYSTEM, messages, tool: "make_database", description: "The database design.", schema: aiDatabaseSpec, maxTokens: r.sampleData ? 16_000 : 8000 });
      return { design };
    }),
  );

  return router;
}
