import { describe, expect, it } from "vitest";
import request from "supertest";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createExporter } from "../src/export.js";
import { createImporter } from "../src/accessImport.js";
import { createSecretBox } from "../src/mysql.js";

const javaTool = { javaBin: "java", jarPath: "none.jar", timeoutMs: 1000, maxConcurrent: 1, maxHeap: "64m" };
const app = createApp({
  connections: { secrets: createSecretBox(path.join(os.tmpdir(), `aw-sup-${process.pid}`), "s"), allowPrivateHosts: true },
  db: openDatabase(":memory:"),
  exportAccdb: createExporter(javaTool),
  importAccess: createImporter(javaTool),
  secureCookies: false,
});
const signUp = async (email: string) => {
  const agent = request.agent(app);
  await agent.post("/api/auth/register").send({ email, name: email.split("@")[0], password: "correct horse", acceptPolicy: true });
  return agent;
};

describe("Send a Copy for Support", () => {
  it("lets the owner send a copy that only admins can see and open", async () => {
    const admin = await signUp("boss@example.com"); // the first account is the admin
    const pat = await signUp("pat@example.com");
    const sam = await signUp("sam@example.com");
    const id = (await pat.post("/api/projects").send({ name: "Shop", template: "contacts" })).body.project.id;

    // Only the owner can send it.
    expect((await sam.post(`/api/projects/${id}/support`).send({ error: "x" })).status).toBe(404);
    const sent = await pat.post(`/api/projects/${id}/support`).send({ error: "Export to Access: it broke", note: "I clicked export" });
    expect(sent.status).toBe(201);

    expect((await pat.get("/api/admin/support")).status).toBe(404);
    const list = (await admin.get("/api/admin/support")).body.copies;
    expect(list).toEqual([expect.objectContaining({ name: "Shop", email: "pat@example.com", error: "Export to Access: it broke", note: "I clicked export", openedAt: null })]);
    expect((await admin.get("/api/admin/overview")).body.supportNew).toBe(1);

    const opened = await admin.post(`/api/admin/support/${list[0].id}/open`).set("X-Requested-With", "fetch");
    expect(opened.status).toBe(201);
    const copy = (await admin.get(`/api/projects/${opened.body.projectId}`)).body.project;
    expect(copy.name).toBe("Support Shop (pat)");
    expect(copy.doc.tables.map((t: { name: string }) => t.name)).toEqual(["Customers", "Orders"]);
    expect((await admin.get("/api/admin/overview")).body.supportNew).toBe(0);
    // The person's own database is untouched.
    expect((await pat.get(`/api/projects/${id}`)).body.project.name).toBe("Shop");

    expect((await admin.delete(`/api/admin/support/${list[0].id}`).set("X-Requested-With", "fetch")).status).toBe(200);
    expect((await admin.get("/api/admin/support")).body.copies).toEqual([]);
  });
});
