import { describe, expect, it, beforeAll } from "vitest";
import request from "supertest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createExporter } from "../src/export.js";
import { createImporter } from "../src/accessImport.js";
import MDBReader from "mdb-reader";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const jarPath = process.env.EXPORTER_JAR ?? path.join(root, "exporter/target/access-exporter.jar");
let javaAvailable = true;
try {
  execFileSync("java", ["-version"], { stdio: "ignore" });
} catch {
  javaAvailable = false;
}

const javaTool = { javaBin: "java", jarPath, timeoutMs: 60_000, maxConcurrent: 1, maxHeap: "256m" };

function makeApp() {
  return createApp({
    db: openDatabase(":memory:"),
    exportAccdb: createExporter(javaTool),
    importAccess: createImporter(javaTool),
    secureCookies: false,
  });
}

async function signUp(app: ReturnType<typeof makeApp>, email: string) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").send({ email, name: "Test User", password: "correct horse" });
  expect(res.status).toBe(201);
  return agent;
}

describe("auth", () => {
  const app = makeApp();

  it("registers, reports the user, logs out and back in", async () => {
    const agent = await signUp(app, "Pat@Example.com");
    expect((await agent.get("/api/auth/me")).body.user.email).toBe("pat@example.com");
    await agent.post("/api/auth/logout").send({});
    expect((await agent.get("/api/auth/me")).body.user).toBeNull();
    expect((await agent.post("/api/auth/login").send({ email: "pat@example.com", password: "wrong pass" })).status).toBe(401);
    const ok = await agent.post("/api/auth/login").send({ email: "PAT@example.com", password: "correct horse" });
    expect(ok.status).toBe(200);
    expect((await agent.get("/api/auth/me")).body.user.name).toBe("Test User");
  });

  it("rejects duplicate emails and weak passwords", async () => {
    await signUp(app, "dup@example.com");
    const dup = await request(app).post("/api/auth/register").send({ email: "dup@example.com", name: "X", password: "longenough" });
    expect(dup.status).toBe(409);
    const weak = await request(app).post("/api/auth/register").send({ email: "w@example.com", name: "X", password: "short" });
    expect(weak.status).toBe(400);
    expect(weak.body.error).toMatch(/8 characters/);
  });

  it("requires JSON for writes and a session for projects", async () => {
    expect((await request(app).post("/api/auth/login").type("form").send("email=a&password=b")).status).toBe(415);
    expect((await request(app).get("/api/projects")).status).toBe(401);
  });
});

describe("projects", () => {
  const app = makeApp();
  let alice: Awaited<ReturnType<typeof signUp>>;
  let bob: Awaited<ReturnType<typeof signUp>>;
  let projectId = "";

  beforeAll(async () => {
    alice = await signUp(app, "alice@example.com");
    bob = await signUp(app, "bob@example.com");
  });

  it("creates from a template and lists it", async () => {
    const res = await alice.post("/api/projects").send({ name: "Shop", template: "contacts" });
    expect(res.status).toBe(201);
    projectId = res.body.project.id;
    expect(res.body.project.doc.tables.map((t: { name: string }) => t.name)).toEqual(["Customers", "Orders"]);
    const list = await alice.get("/api/projects");
    expect(list.body.projects).toHaveLength(1);
    expect(list.body.projects[0].tableCount).toBe(2);
  });

  it("keeps each user's databases private", async () => {
    expect((await bob.get(`/api/projects/${projectId}`)).status).toBe(404);
    expect((await bob.get("/api/projects")).body.projects).toHaveLength(0);
    expect((await bob.delete(`/api/projects/${projectId}`).set("X-Requested-With", "fetch")).status).toBe(404);
    expect((await bob.get(`/api/projects/${projectId}/export.accdb`)).status).toBe(404);
  });

  it("saves with revision checks and rejects inconsistent documents", async () => {
    const { body } = await alice.get(`/api/projects/${projectId}`);
    const doc = body.project.doc;
    doc.tables[0].rows[0].c_city = "Paris";
    const saved = await alice.put(`/api/projects/${projectId}`).send({ doc, baseRevision: 1 });
    expect(saved.status).toBe(200);
    expect(saved.body.project.revision).toBe(2);

    const stale = await alice.put(`/api/projects/${projectId}`).send({ doc, baseRevision: 1 });
    expect(stale.status).toBe(409);

    const bad = structuredClone(doc);
    bad.tables[1].name = "customers";
    const rejected = await alice.put(`/api/projects/${projectId}`).send({ doc: bad, baseRevision: 2 });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/Two tables/);

    const badName = await alice.put(`/api/projects/${projectId}`).send({ name: "a.b", baseRevision: 2 });
    expect(badName.status).toBe(400);

    const reloaded = await alice.get(`/api/projects/${projectId}`);
    expect(reloaded.body.project.doc.tables[0].rows[0].c_city).toBe("Paris");
  });

  it.skipIf(!javaAvailable)("exports a real .accdb file", async () => {
    const res = await alice
      .get(`/api/projects/${projectId}/export.accdb`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("Shop.accdb");
    const bytes = res.body as Buffer;
    // Every ACE/Jet database starts with this signature.
    expect(bytes.subarray(4, 19).toString("latin1")).toBe("Standard ACE DB");
    // Read it back with an independent library (not Jackcess) to check the contents.
    const db = new MDBReader(bytes);
    expect(db.getTableNames()).toEqual(["Customers", "Orders", "_SavedQueries"]);
    const customers = db.getTable("Customers");
    expect(customers.rowCount).toBe(5);
    expect(customers.getData().find((r) => r.CustomerID === 1)?.City).toBe("Paris");
    expect(db.getTable("_SavedQueries").getData().map((r) => r.QueryName)).toContain("Sales by Customer");
  }, 60_000);

  it.skipIf(!javaAvailable)("imports an Access file as a new database, round-tripping the export", async () => {
    const exported = await alice
      .get(`/api/projects/${projectId}/export.accdb`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    const res = await alice
      .post("/api/projects/import-access?name=Imported")
      .set("Content-Type", "application/octet-stream")
      .set("X-Requested-With", "fetch")
      .send(exported.body as Buffer);
    expect(res.status).toBe(201);
    const doc = res.body.project.doc;
    expect(doc.tables.map((t: { name: string }) => t.name)).toEqual(["Customers", "Orders"]);
    const customers = doc.tables[0];
    expect(customers.fields.find((f: { name: string }) => f.name === "CustomerID")).toMatchObject({ type: "AutoNumber", primaryKey: true });
    expect(customers.fields.find((f: { name: string }) => f.name === "Email")).toMatchObject({ indexed: "YesNoDup", size: 120 });
    expect(customers.rows).toHaveLength(5);
    expect(customers.nextAutoNumber).toBe(6);
    expect(doc.relationships).toHaveLength(1);
    expect(doc.relationships[0]).toMatchObject({ fromTable: customers.id, toTable: doc.tables[1].id, enforce: true });
    // The _SavedQueries table turns back into real queries.
    expect(doc.queries.map((q: { name: string }) => q.name).sort()).toEqual(["Active Customers", "Order Details", "Sales by Customer"]);
    expect((await alice.get("/api/projects")).body.projects).toHaveLength(2);

    const converted = await alice
      .post("/api/projects/convert-access")
      .set("Content-Type", "application/octet-stream")
      .set("X-Requested-With", "fetch")
      .send(exported.body as Buffer);
    expect(converted.status).toBe(200);
    expect(converted.body.doc.tables).toHaveLength(2);
    expect((await alice.get("/api/projects")).body.projects).toHaveLength(2);
    await alice.delete(`/api/projects/${res.body.project.id}`).set("X-Requested-With", "fetch");
  }, 60_000);

  it("rejects files that aren't Access databases", async () => {
    const res = await alice
      .post("/api/projects/import-access?name=Bad")
      .set("Content-Type", "application/octet-stream")
      .set("X-Requested-With", "fetch")
      .send(Buffer.from("this is not a database at all, just some text"));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/isn't a Microsoft Access database/);
  });

  it("deletes", async () => {
    expect((await alice.delete(`/api/projects/${projectId}`).set("X-Requested-With", "fetch")).status).toBe(200);
    expect((await alice.get("/api/projects")).body.projects).toHaveLength(0);
  });
});

describe("sharing", () => {
  const app = makeApp();
  const json = (agent: Awaited<ReturnType<typeof signUp>>) => ({
    put: (url: string, body: unknown) => agent.put(url).send(body as object),
    del: (url: string) => agent.delete(url).set("X-Requested-With", "fetch"),
  });
  let owner: Awaited<ReturnType<typeof signUp>>;
  let editor: Awaited<ReturnType<typeof signUp>>;
  let viewer: Awaited<ReturnType<typeof signUp>>;
  let stranger: Awaited<ReturnType<typeof signUp>>;
  let id = "";

  beforeAll(async () => {
    owner = await signUp(app, "owner@example.com");
    editor = await signUp(app, "editor@example.com");
    viewer = await signUp(app, "viewer@example.com");
    stranger = await signUp(app, "stranger@example.com");
    id = (await owner.post("/api/projects").send({ name: "Team DB", template: "contacts" })).body.project.id;
  });

  it("shares with registered users by email and lists them under Shared with me", async () => {
    expect((await json(owner).put(`/api/projects/${id}/shares`, { email: "Editor@Example.com", permission: "edit" })).status).toBe(200);
    const res = await json(owner).put(`/api/projects/${id}/shares`, { email: "viewer@example.com", permission: "view" });
    expect(res.body.shares.map((s: { email: string; permission: string }) => `${s.email}:${s.permission}`).sort()).toEqual([
      "editor@example.com:edit",
      "viewer@example.com:view",
    ]);
    const missing = await json(owner).put(`/api/projects/${id}/shares`, { email: "nobody@example.com", permission: "view" });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatch(/registered/);

    const list = (await editor.get("/api/projects")).body;
    expect(list.projects).toHaveLength(0);
    expect(list.shared[0]).toMatchObject({ id, role: "edit", ownerName: "Test User" });
    expect((await viewer.get(`/api/projects/${id}`)).body.project.role).toBe("view");
  });

  it("enforces roles: editors save, viewers and strangers can't, only owners manage", async () => {
    const { body } = await editor.get(`/api/projects/${id}`);
    const doc = body.project.doc;
    doc.tables[0].rows[0].c_city = "Edited";
    const saved = await editor.put(`/api/projects/${id}`).send({ doc, baseRevision: body.project.revision });
    expect(saved.status).toBe(200);

    const v = await viewer.get(`/api/projects/${id}`);
    expect((await viewer.put(`/api/projects/${id}`).send({ doc, baseRevision: v.body.project.revision })).status).toBe(403);
    expect((await editor.put(`/api/projects/${id}`).send({ name: "Renamed", baseRevision: saved.body.project.revision })).status).toBe(403);
    expect((await json(editor).put(`/api/projects/${id}/shares`, { email: "stranger@example.com", permission: "edit" })).status).toBe(403);
    expect((await stranger.get(`/api/projects/${id}`)).status).toBe(404);

    // The owner's next save without reloading names who changed it.
    const stale = await owner.put(`/api/projects/${id}`).send({ doc, baseRevision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/Test User saved changes/);
    expect((await owner.get(`/api/projects/${id}/revision`)).body.revision).toBe(2);
  });

  it("supports anyone-with-the-link access", async () => {
    expect((await json(owner).put(`/api/projects/${id}/link-access`, { linkAccess: "view" })).body.linkAccess).toBe("view");
    expect((await stranger.get("/api/projects")).body.shared).toHaveLength(0);
    expect((await stranger.get(`/api/projects/${id}`)).body.project.role).toBe("view");
    expect((await stranger.get("/api/projects")).body.shared).toHaveLength(1); // remembered once opened
    // A link share never lowers a specific share.
    await json(owner).put(`/api/projects/${id}/link-access`, { linkAccess: "edit" });
    expect((await stranger.get(`/api/projects/${id}`)).body.project.role).toBe("edit");
    await json(owner).put(`/api/projects/${id}/link-access`, { linkAccess: "none" });
    expect((await stranger.get(`/api/projects/${id}`)).status).toBe(404);
    expect((await stranger.get("/api/projects")).body.shared).toHaveLength(0);
  });

  it("lets anyone with access save a copy, and non-owners only remove it from their list", async () => {
    const copy = await viewer.post(`/api/projects/${id}/copy`).send({ name: "My Copy" });
    expect(copy.status).toBe(201);
    expect(copy.body.project.role).toBe("owner");
    expect(copy.body.project.doc.tables[0].rows[0].c_city).toBe("Edited");

    const removed = await json(viewer).del(`/api/projects/${id}`);
    expect(removed.body.removedOnly).toBe(true);
    expect((await viewer.get(`/api/projects/${id}`)).status).toBe(404);
    expect((await owner.get(`/api/projects/${id}`)).status).toBe(200);

    await json(owner).del(`/api/projects/${id}/shares/${(await editor.get("/api/auth/me")).body.user.id}`);
    expect((await editor.get(`/api/projects/${id}`)).status).toBe(404);
  });
});
