import { describe, expect, it } from "vitest";
import request from "supertest";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createExporter } from "../src/export.js";
import { createImporter } from "../src/accessImport.js";
import { createSecretBox } from "../src/mysql.js";
import type { AiOptions } from "../src/ai.js";

const javaTool = { javaBin: "java", jarPath: "none.jar", timeoutMs: 1000, maxConcurrent: 1, maxHeap: "64m" };

/** A stand-in for Anthropic's API that answers with the tool input given. */
function fakeApi(answer: (body: { tools: { name: string }[]; messages: { content: string }[] }) => unknown, seen: unknown[] = []) {
  return (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    const body = JSON.parse(init.body);
    seen.push({ ...body, headers: init.headers });
    const input = answer(body);
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: body.tools[0].name, input }], stop_reason: "tool_use" }), { status: 200 });
  }) as unknown as typeof fetch;
}

function makeApp(ai?: Partial<AiOptions>) {
  return createApp({
    connections: { secrets: createSecretBox(path.join(os.tmpdir(), `aw-ai-${process.pid}`), "s"), allowPrivateHosts: true },
    db: openDatabase(":memory:"),
    exportAccdb: createExporter(javaTool),
    importAccess: createImporter(javaTool),
    secureCookies: false,
    ...(ai ? { ai: { apiKey: "test-key", model: "test-model", dailyLimit: 3, ...ai } } : {}),
  });
}

async function signUp(app: ReturnType<typeof makeApp>) {
  const agent = request.agent(app);
  await agent.post("/api/auth/register").send({ email: `ai${Math.random()}@example.com`, name: "Ai User", password: "correct horse", acceptPolicy: true });
  return agent;
}

const schema = "Table [Customers]\n  [CustomerID] AutoNumber; primary key\n  [City] Short Text(60)";

describe("AI assistant", () => {
  it("is off without a key", async () => {
    const agent = await signUp(makeApp());
    expect((await agent.get("/api/ai/status")).body).toMatchObject({ configured: false, available: false });
    const r = await agent.post("/api/ai/query").send({ prompt: "x", schema });
    expect(r.status).toBe(503);
  });

  it("writes a query from a description, with the design and earlier turns", async () => {
    const seen: { model: string; tool_choice: unknown; messages: { content: string }[]; headers: Record<string, string> }[] = [];
    const app = makeApp({ fetchImpl: fakeApi(() => ({ name: "Customers in Austin", sql: 'SELECT * FROM [Customers] WHERE [City] = "Austin";', explanation: "Customers whose city is Austin." }), seen) });
    const agent = await signUp(app);
    const r = await agent.post("/api/ai/query").send({ prompt: "customers in austin", schema, history: [{ prompt: "all customers", sql: "SELECT * FROM [Customers];" }] });
    expect(r.status).toBe(200);
    expect(r.body.query.name).toBe("Customers in Austin");
    expect(r.body.remaining).toBe(2);
    expect(seen[0].model).toBe("test-model");
    expect(seen[0].headers["x-api-key"]).toBe("test-key");
    expect(seen[0].tool_choice).toEqual({ type: "tool", name: "make_query" });
    expect(seen[0].messages[0].content).toContain("[Customers]");
    expect(seen[0].messages.at(-1)!.content).toBe("customers in austin");
  });

  it("refuses queries that would change data, and answers that don't fit", async () => {
    const agent = await signUp(makeApp({ fetchImpl: fakeApi(() => ({ name: "Oops", sql: "DELETE FROM [Customers];", explanation: "x" })) }));
    const r = await agent.post("/api/ai/query").send({ prompt: "remove everyone", schema });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/change data/);
    const bad = await (await signUp(makeApp({ fetchImpl: fakeApi(() => ({ nope: 1 })) }))).post("/api/ai/query").send({ prompt: "x", schema });
    expect(bad.status).toBe(502);
  });

  it("designs a database and keeps to the daily limit", async () => {
    const design = { name: "Volunteers", summary: "Volunteers and shifts.", tables: [{ name: "Volunteers", fields: [{ name: "VolunteerID", type: "AutoNumber" }, { name: "Name", type: "ShortText", size: 80 }] }] };
    const agent = await signUp(makeApp({ fetchImpl: fakeApi(() => design) }));
    for (let i = 0; i < 3; i++) expect((await agent.post("/api/ai/database").send({ prompt: "volunteers", sampleData: false })).status).toBe(200);
    const over = await agent.post("/api/ai/database").send({ prompt: "volunteers" });
    expect(over.status).toBe(402);
    expect(over.body.error).toMatch(/today/);
    expect((await agent.get("/api/ai/status")).body).toMatchObject({ available: false, remaining: 0 });
  });

  it("explains a busy or refused API plainly", async () => {
    const busy = (async () => new Response(JSON.stringify({ error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529 })) as unknown as typeof fetch;
    const r = await (await signUp(makeApp({ fetchImpl: busy }))).post("/api/ai/query").send({ prompt: "x", schema });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/busy/);
  });
});
