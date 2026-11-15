import { describe, expect, it, beforeAll } from "vitest";
import request from "supertest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createExporter } from "../src/export.js";
import { createImporter } from "../src/accessImport.js";
import { createSecretBox, isPrivateAddress } from "../src/mysql.js";
import os from "node:os";
import MDBReader from "mdb-reader";
import Stripe from "stripe";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const jarPath = process.env.EXPORTER_JAR ?? path.join(root, "exporter/target/access-exporter.jar");
let javaAvailable = true;
try {
  execFileSync("java", ["-version"], { stdio: "ignore" });
} catch {
  javaAvailable = false;
}

const javaTool = { javaBin: "java", jarPath, timeoutMs: 60_000, maxConcurrent: 1, maxHeap: "256m" };

const dataDir = path.join(os.tmpdir(), `accessweb-test-${process.pid}`);

function makeApp(opts: { allowPrivateHosts?: boolean } = {}) {
  return createApp({
    connections: { secrets: createSecretBox(dataDir, "test-secret"), allowPrivateHosts: opts.allowPrivateHosts ?? true },
    db: openDatabase(":memory:"),
    exportAccdb: createExporter(javaTool),
    importAccess: createImporter(javaTool),
    secureCookies: false,
  });
}

async function signUp(app: ReturnType<typeof makeApp>, email: string) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").send({ email, name: "Test User", password: "correct horse", acceptPolicy: true });
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
    const dup = await request(app).post("/api/auth/register").send({ email: "dup@example.com", name: "X", password: "longenough", acceptPolicy: true });
    expect(dup.status).toBe(409);
    const weak = await request(app).post("/api/auth/register").send({ email: "w@example.com", name: "X", password: "short", acceptPolicy: true });
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

  it("publishes for public viewing without an account, with no export or copy", async () => {
    const anon = request(app);
    expect((await anon.get(`/api/public/${id}`)).status).toBe(404);
    expect((await json(editor).put(`/api/projects/${id}/public-access`, { publicView: true })).status).toBe(403);
    const on = await json(owner).put(`/api/projects/${id}/public-access`, { publicView: true });
    expect(on.body.publicView).toBe(true);

    const pub = await anon.get(`/api/public/${id}`);
    expect(pub.status).toBe(200);
    expect(pub.body.project).toMatchObject({ id, role: "view", publicView: true });
    expect(pub.body.project.updatedByName).toBeUndefined();
    expect(pub.body.project.doc.tables.length).toBeGreaterThan(0);
    expect((await anon.get(`/api/public/${id}/revision`)).body.revision).toBeGreaterThan(0);

    // Everything else still needs an account with access.
    expect((await anon.get(`/api/projects/${id}`)).status).toBe(401);
    expect((await anon.get(`/api/projects/${id}/export.accdb`)).status).toBe(401);
    expect((await stranger.get(`/api/projects/${id}`)).status).toBe(404);
    expect((await stranger.get(`/api/projects/${id}/export.accdb`)).status).toBe(404);
    expect((await stranger.post(`/api/projects/${id}/copy`).send({ name: "Mine" })).status).toBe(404);
    expect((await stranger.get(`/api/projects/${id}/connections`)).status).toBe(404);
    expect((await anon.put(`/api/projects/${id}`).send({ baseRevision: 1, name: "x" })).status).toBe(401);

    await json(owner).put(`/api/projects/${id}/public-access`, { publicView: false });
    expect((await anon.get(`/api/public/${id}`)).status).toBe(404);
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

/**
 * MySQL connections. Uses a real MySQL/MariaDB server when MYSQL_TEST_URL is set, e.g.
 * mysql://webapp:S3cret!pw@127.0.0.1:3306/shop with the sample tables from the README.
 */
const mysqlUrl = process.env.MYSQL_TEST_URL;
describe.skipIf(!mysqlUrl)("mysql connections", () => {
  const app = makeApp();
  const url = new URL(mysqlUrl ?? "mysql://x@localhost/x");
  const settings = {
    name: "Shop",
    host: url.hostname,
    port: Number(url.port || 3306),
    database: url.pathname.slice(1),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: "off",
  };
  let owner: Awaited<ReturnType<typeof signUp>>;
  let viewer: Awaited<ReturnType<typeof signUp>>;
  let id = "";
  let cid = "";
  const base = () => `/api/projects/${id}/connections`;

  beforeAll(async () => {
    owner = await signUp(app, "dba@example.com");
    viewer = await signUp(app, "looker@example.com");
    id = (await owner.post("/api/projects").send({ name: "Ext", template: "blank" })).body.project.id;
    await owner.put(`/api/projects/${id}/shares`).send({ email: "looker@example.com", permission: "view" });
  });

  it("tests settings before saving, with mysql-style errors", async () => {
    const ok = await owner.post(`${base()}/test`).send({ settings });
    expect(ok.body).toMatchObject({ ok: true, database: settings.database });
    expect(ok.body.version).toMatch(/\d+\.\d+/);
    const bad = await owner.post(`${base()}/test`).send({ settings: { ...settings, password: "wrong" } });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error).toMatchObject({ errno: 1045, sqlState: "28000" });
    const refused = await owner.post(`${base()}/test`).send({ settings: { ...settings, port: 1 } });
    expect(refused.body.error.message).toMatch(/Can't connect to MySQL server/);
    // A mysql:// URL pasted into the server box fills in the other settings.
    const fromUrl = await owner.post(`${base()}/test`).send({ settings: { ...settings, host: mysqlUrl, user: "", password: undefined, database: "" } });
    expect(fromUrl.body.ok).toBe(true);
  });

  it("saves connections with the password encrypted and never returned", async () => {
    const created = await owner.post(base()).send(settings);
    expect(created.status).toBe(201);
    cid = created.body.connection.id;
    expect(created.body.connection).toMatchObject({ name: "Shop", hasPassword: true });
    expect(JSON.stringify(created.body)).not.toContain(settings.password);
    const list = await viewer.get(base());
    expect(list.body.connections).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(settings.password);
    // Editing without a password keeps it; Test Connection uses the saved one.
    const { password: _p, ...noPassword } = settings;
    expect((await owner.put(`${base()}/${cid}`).send({ ...noPassword, name: "Shop DB" })).body.connection.name).toBe("Shop DB");
    expect((await owner.post(`${base()}/test`).send({ connectionId: cid, settings: noPassword })).body.ok).toBe(true);
    // Viewers can't change connections or run SQL.
    expect((await viewer.post(base()).send(settings)).status).toBe(403);
    expect((await viewer.post(`${base()}/${cid}/sql`).send({ sql: "SELECT 1" })).status).toBe(403);
  });

  it("lists and browses remote tables, mapping MySQL types", async () => {
    const tables = (await viewer.get(`${base()}/${cid}/tables`)).body.tables;
    expect(tables.map((t: { name: string; type: string }) => `${t.name}:${t.type}`)).toEqual(
      expect.arrayContaining(["customers:table", "orders:table", "products:table", "big_orders:view"]),
    );
    const rows = (await viewer.get(`${base()}/${cid}/tables/customers/rows?limit=2`)).body;
    expect(rows.total).toBe(3);
    expect(rows.rows).toHaveLength(2);
    const types = Object.fromEntries(rows.fields.map((f: { name: string; type: string }) => [f.name, f.type]));
    expect(types).toMatchObject({ id: "AutoNumber", name: "ShortText", joined: "DateTime", vip: "YesNo", notes: "LongText", balance: "Currency" });
    expect(rows.rows[0]).toEqual([1, "Ada Lovelace", "ada@example.com", "2026-01-12", true, "first", 12.5]);
    const products = (await viewer.get(`${base()}/${cid}/tables/products/rows`)).body;
    expect(products.skipped).toEqual(["raw"]); // BLOB
    expect(products.rows[0]).toContain("2026-05-01T10:30");
  });

  it("reads foreign keys, so linked tables can be joined", async () => {
    const { foreignKeys } = (await viewer.get(`${base()}/${cid}/foreign-keys`)).body;
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        { name: "orders_ibfk_1", table: "orders", refTable: "customers", columns: [{ field: "customer_id", refField: "id" }] },
        { name: "orders_ibfk_2", table: "orders", refTable: "products", columns: [{ field: "sku", refField: "sku" }] },
      ]),
    );
  });

  it("runs SQL like the mysql client: result sets, OK packets and errors", async () => {
    const sql = (q: string) => owner.post(`${base()}/${cid}/sql`).send({ sql: q }).then((r) => r.body);
    const rows = await sql("SELECT name, balance FROM customers WHERE vip = 1 ORDER BY id");
    expect(rows).toMatchObject({ kind: "rows", columns: ["name", "balance"], rows: [["Ada Lovelace", 12.5], ["Linus T", 99.99]] });
    const upd = await sql("UPDATE customers SET notes = 'vip' WHERE vip = 1");
    expect(upd).toMatchObject({ kind: "ok", affectedRows: 2 });
    expect(upd.info).toMatch(/Rows matched: 2/);
    const err = await sql("SELECT * FROM nope");
    expect(err).toMatchObject({ kind: "error", errno: 1146, sqlState: "42S02" });
    expect(err.message).toMatch(/nope' doesn't exist/);
    expect((await sql("SELECT 1; SELECT 2")).kind).toBe("error"); // one statement at a time
    await sql("UPDATE customers SET notes = 'first' WHERE id = 1");
  });

  it("imports tables with keys, indexes and foreign keys as relationships", async () => {
    const res = await owner.post(`${base()}/${cid}/import`).send({ tables: ["customers", "products", "orders"] });
    expect(res.status).toBe(200);
    const doc = res.body.doc;
    const customers = doc.tables.find((t: { name: string }) => t.name === "customers");
    expect(customers.fields.find((f: { name: string }) => f.name === "id")).toMatchObject({ type: "AutoNumber", primaryKey: true });
    expect(customers.fields.find((f: { name: string }) => f.name === "email")).toMatchObject({ indexed: "YesNoDup", size: 120 });
    expect(customers.fields.find((f: { name: string }) => f.name === "name")).toMatchObject({ required: true, description: "Full name" });
    expect(customers.rows).toHaveLength(3);
    expect(customers.nextAutoNumber).toBe(4);
    expect(doc.relationships).toHaveLength(2);
    expect(res.body.warnings.join(" ")).toMatch(/products.raw/);
  });

  it("blocks private network addresses unless allowed", async () => {
    expect(isPrivateAddress("127.0.0.1") && isPrivateAddress("10.1.2.3") && isPrivateAddress("169.254.169.254") && isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    const strict = makeApp({ allowPrivateHosts: false });
    const a = await signUp(strict, "strict@example.com");
    const pid = (await a.post("/api/projects").send({ name: "S", template: "blank" })).body.project.id;
    const r = await a.post(`/api/projects/${pid}/connections/test`).send({ settings: { ...settings, host: "127.0.0.1" } });
    expect(r.body.ok).toBe(false);
    expect(r.body.error.message).toMatch(/private and internal network addresses are blocked/);
  });
});

describe("pictures in Image fields", () => {
  const app = makeApp();
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4ab0000000049454e44ae426082", "hex");
  const upload = (agent: ReturnType<typeof request.agent>, pid: string, body: Buffer) =>
    agent.post(`/api/projects/${pid}/images`).set("X-Requested-With", "fetch").set("Content-Type", "application/octet-stream").send(body);

  it("stores pictures, checks they are pictures, and serves them to people who can view", async () => {
    const owner = await signUp(app, "pics@example.com");
    const other = await signUp(app, "nopics@example.com");
    const pid = (await owner.post("/api/projects").send({ name: "Pics", template: "blank" })).body.project.id;
    const up = await upload(owner, pid, png);
    expect(up.status).toBe(201);
    expect(up.body.id).toMatch(/^img_[0-9a-f]{32}$/);
    expect(up.body.mime).toBe("image/png");
    const got = await owner.get(`/api/projects/${pid}/images/${up.body.id}`);
    expect(got.status).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(Buffer.from(got.body).equals(png)).toBe(true);

    expect((await upload(owner, pid, Buffer.from("<svg onload=alert(1)>"))).status).toBe(400);
    expect((await upload(other, pid, png)).status).toBe(404);
    expect((await other.get(`/api/projects/${pid}/images/${up.body.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/public/${pid}/images/${up.body.id}`)).status).toBe(404);
    await owner.put(`/api/projects/${pid}/public-access`).send({ publicView: true });
    expect((await request(app).get(`/api/public/${pid}/images/${up.body.id}`)).status).toBe(200);

    // Save a copy keeps the pictures.
    const copy = (await owner.post(`/api/projects/${pid}/copy`).send({ name: "Pics copy" })).body.project.id;
    expect((await owner.get(`/api/projects/${copy}/images/${up.body.id}`)).status).toBe(200);
  });
});

describe("public report links", () => {
  const app = makeApp();
  const snapshot = (title: string) => ({ v: 1, title, report: { columns: ["FirstName"] }, columns: ["FirstName"], fields: [{ type: "ShortText" }], rows: [["Ada"], ["Grace"]] });

  it("lets the owner share one report's rows publicly, editors refresh it, and stopping kills the link", async () => {
    const owner = await signUp(app, "pub-owner@example.com");
    const editor = await signUp(app, "pub-editor@example.com");
    const { body } = await owner.post("/api/projects").send({ name: "Pub", template: "contacts" });
    const pid = body.project.id;
    const doc = body.project.doc;
    doc.reports.push({ id: "rpt_names", name: "Names", title: "Names", source: { kind: "table", id: doc.tables[0].id }, columns: ["FirstName"] });
    const saved = await owner.put(`/api/projects/${pid}`).send({ doc, baseRevision: body.project.revision });
    expect(saved.status).toBe(200);
    await owner.put(`/api/projects/${pid}/shares`).send({ email: "pub-editor@example.com", permission: "edit" });

    // Only the owner can make a report public.
    expect((await editor.put(`/api/projects/${pid}/public-reports/rpt_names`).send({ snapshot: snapshot("x") })).status).toBe(403);
    const made = await owner.put(`/api/projects/${pid}/public-reports/rpt_names`).send({ snapshot: snapshot("Names") });
    expect(made.status).toBe(200);
    const token = made.body.token as string;
    expect(token.length).toBeGreaterThanOrEqual(20);

    // Anyone can read it without signing in, and gets only the report's rows, not the database.
    const pub = await request(app).get(`/api/public-reports/${token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.snapshot.rows).toEqual([["Ada"], ["Grace"]]);
    expect(JSON.stringify(pub.body)).not.toMatch(/tables|relationships/);
    expect((await request(app).get(`/api/public/${pid}`)).status).toBe(404);

    // Editors refresh the copy; the link stays the same.
    const refreshed = await editor.put(`/api/projects/${pid}/public-reports/rpt_names`).send({ snapshot: snapshot("Renamed") });
    expect(refreshed.body.token).toBe(token);
    expect((await request(app).get(`/api/public-reports/${token}`)).body.snapshot.title).toBe("Renamed");
    expect((await editor.get(`/api/projects/${pid}/public-reports`)).body.reports).toEqual([expect.objectContaining({ reportId: "rpt_names", token })]);

    // Bad snapshots and unknown reports are refused.
    expect((await owner.put(`/api/projects/${pid}/public-reports/rpt_names`).send({ snapshot: { v: 2 } })).status).toBe(400);
    expect((await owner.put(`/api/projects/${pid}/public-reports/nope`).send({ snapshot: snapshot("x") })).status).toBe(404);

    // Stopping (owner only) kills the link.
    expect((await editor.delete(`/api/projects/${pid}/public-reports/rpt_names`).set("X-Requested-With", "fetch")).status).toBe(403);
    expect((await owner.delete(`/api/projects/${pid}/public-reports/rpt_names`).set("X-Requested-With", "fetch")).status).toBe(200);
    expect((await request(app).get(`/api/public-reports/${token}`)).status).toBe(404);
  });

  it("stops sharing a report when it's deleted from the database", async () => {
    const owner = await signUp(app, "pub-owner2@example.com");
    const { body } = await owner.post("/api/projects").send({ name: "Pub2", template: "contacts" });
    const pid = body.project.id;
    const doc = body.project.doc;
    doc.reports.push({ id: "rpt_x", name: "X", title: "X", source: { kind: "table", id: doc.tables[0].id }, columns: ["FirstName"] });
    const s1 = await owner.put(`/api/projects/${pid}`).send({ doc, baseRevision: body.project.revision });
    const token = (await owner.put(`/api/projects/${pid}/public-reports/rpt_x`).send({ snapshot: snapshot("X") })).body.token;
    doc.reports = doc.reports.filter((r: { id: string }) => r.id !== "rpt_x");
    await owner.put(`/api/projects/${pid}`).send({ doc, baseRevision: s1.body.project.revision });
    expect((await request(app).get(`/api/public-reports/${token}`)).status).toBe(404);
  });
});

describe("recording from a tag's public page", () => {
  const app = makeApp();
  it("lets only allowed, signed-in people record; everyone else just sees the report", async () => {
    const owner = await signUp(app, "rec-owner@example.com");
    const taker = await signUp(app, "taker@example.com");
    const stranger = await signUp(app, "rec-stranger@example.com");
    const { body } = await owner.post("/api/projects").send({ name: "Event", template: "contacts" });
    const pid = body.project.id;
    const doc = body.project.doc;
    const people = doc.tables[0];
    // An attendance log, a labels-style report, and a scan action the taker may run.
    doc.tables.push({ id: "t_att", name: "Attendance", nextAutoNumber: 1, rows: [], fields: [
      { id: "a_id", name: "AttendanceID", type: "AutoNumber", primaryKey: true, required: true },
      { id: "a_p", name: "CustomerID", type: "Number", numberSize: "Long" },
      { id: "a_t", name: "ScannedAt", type: "DateTime" },
    ] });
    doc.reports.push({ id: "rpt_tags", name: "Tags", title: "Tags", source: { kind: "table", id: people.id }, columns: ["FirstName"] });
    doc.scanActions = [{ id: "sa1", name: "Take attendance", people: people.id, kind: "add", table: "t_att", personField: "a_p", timeField: "a_t", once: true, recorders: ["Taker@Example.com"] }];
    expect((await owner.put(`/api/projects/${pid}`).send({ doc, baseRevision: body.project.revision })).status).toBe(200);
    const snap = { v: 1, title: "Tags", report: {}, columns: ["FirstName"], fields: [null], rows: [["Ada"]] };
    const token = (await owner.put(`/api/projects/${pid}/public-reports/rpt_tags`).send({ snapshot: snap })).body.token;
    const q = `/api/public-reports/${token}/record?key=CustomerID&rec=1`;

    // Signed out: nothing to record, and recording is refused.
    expect((await request(app).get(q)).body).toEqual({ signedIn: false, actions: [] });
    expect((await request(app).post(`/api/public-reports/${token}/record`).send({ actionId: "sa1", key: "CustomerID", rec: "1" })).status).toBe(401);
    // A signed-in stranger: nothing offered, and refused.
    expect((await stranger.get(q)).body.actions).toEqual([]);
    expect((await stranger.post(`/api/public-reports/${token}/record`).send({ actionId: "sa1", key: "CustomerID", rec: "1" })).status).toBe(403);

    // The attendance taker (no access to the database) can record, once.
    const opts = (await taker.get(q)).body;
    expect(opts).toMatchObject({ signedIn: true, person: "Ada Lovelace", actions: [{ id: "sa1", name: "Take attendance", done: null }] });
    const rec1 = await taker.post(`/api/public-reports/${token}/record`).send({ actionId: "sa1", key: "CustomerID", rec: "1", now: new Date().toISOString().slice(0, 19) });
    expect(rec1.body).toMatchObject({ ok: true, person: "Ada Lovelace" });
    expect((await taker.post(`/api/public-reports/${token}/record`).send({ actionId: "sa1", key: "CustomerID", rec: "1" })).body).toMatchObject({ ok: false, already: true });
    expect((await taker.get(q)).body.actions[0].done).toMatch(/^Recorded/);
    expect((await taker.get(`/api/projects/${pid}`)).status).toBe(404);

    // It's saved in the database, with a new revision the owner's app picks up.
    const after = (await owner.get(`/api/projects/${pid}`)).body.project;
    const att = after.doc.tables.find((t: { id: string }) => t.id === "t_att");
    expect(att.rows).toHaveLength(1);
    expect(att.rows[0]).toMatchObject({ a_id: 1, a_p: 1 });
    expect(after.revision).toBe(body.project.revision + 2);
  });
});

describe("admin page", () => {
  it("lets only the first account (or ADMIN_EMAILS) see accounts and the activity log, without table contents", async () => {
    const app = makeApp();
    const admin = await signUp(app, "owner@example.com");
    const pat = await signUp(app, "pat@example.com");
    expect((await admin.get("/api/auth/me")).body.user.admin).toBe(true);
    expect((await pat.get("/api/auth/me")).body.user.admin).toBeUndefined();
    expect((await pat.get("/api/admin/overview")).status).toBe(404);
    expect((await request(app).get("/api/admin/users")).status).toBe(401);

    // Pat works on a database: create, open, save twice (folded into one line), share, and a failed sign-in.
    const created = (await pat.post("/api/projects").send({ name: "Secret Plans", template: "contacts" })).body.project;
    await pat.get(`/api/projects/${created.id}`);
    const doc = created.doc;
    doc.tables[0].rows.push({ _id: "r1", [doc.tables[0].fields[1].id]: "TOP SECRET VALUE" });
    let rev = (await pat.put(`/api/projects/${created.id}`).send({ doc, baseRevision: created.revision })).body.project.revision;
    rev = (await pat.put(`/api/projects/${created.id}`).send({ doc, baseRevision: rev })).body.project.revision;
    expect((await pat.put(`/api/projects/${created.id}/shares`).send({ email: "owner@example.com", permission: "view" })).status).toBe(200);
    await request(app).post("/api/auth/login").send({ email: "pat@example.com", password: "nope nope" });

    const overview = (await admin.get("/api/admin/overview")).body;
    expect(overview).toMatchObject({ users: 2, newUsers7: 2, databases: 1, shares: 1, failedLogins24: 1 });
    expect(overview.days).toHaveLength(30);
    expect(overview.days[29].signups).toBe(2);

    const users = (await admin.get("/api/admin/users")).body.users;
    const patRow = users.find((u: { email: string }) => u.email === "pat@example.com");
    expect(patRow).toMatchObject({ databases: 1, admin: false });
    expect(patRow.storageBytes).toBeGreaterThan(0);
    expect((await admin.get("/api/admin/users?q=owner")).body.users).toHaveLength(1);

    const detail = (await admin.get(`/api/admin/users/${patRow.id}`)).body;
    expect(detail.dbs).toEqual([expect.objectContaining({ name: "Secret Plans", tables: 2, sharedWith: 1 })]);
    expect(detail.dbs[0].records).toBeGreaterThan(0);
    const actions = detail.activity.map((e: { action: string }) => e.action);
    expect(actions).toEqual(["share", "save", "open_db", "create_db", "register"]);
    const save = detail.activity.find((e: { action: string }) => e.action === "save");
    expect(save).toMatchObject({ count: 2, projectName: "Secret Plans" });
    expect(save.detail).toMatch(/2 tables, \d+ records/);
    // Nothing from inside the tables is ever logged.
    expect(JSON.stringify(detail)).not.toContain("TOP SECRET VALUE");

    const failed = (await admin.get("/api/admin/activity?action=login_failed")).body.entries;
    expect(failed).toEqual([expect.objectContaining({ action: "login_failed", detail: "pat@example.com", userId: null })]);
    const page = (await admin.get("/api/admin/activity?limit=2")).body;
    expect(page.entries).toHaveLength(2);
    const next = (await admin.get(`/api/admin/activity?limit=2&before=${page.more}`)).body;
    expect(next.entries[0].id).toBeLessThan(page.entries[1].id);
    expect((await admin.get("/api/admin/activity?q=secret")).body.entries.length).toBeGreaterThan(0);

    const csv = await admin.get("/api/admin/activity.csv");
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.text).toContain("Saved changes");

    // Deleting the database is logged with its name.
    expect((await pat.delete(`/api/projects/${created.id}`).set("X-Requested-With", "fetch")).status).toBe(200);
    expect((await admin.get("/api/admin/activity?action=delete_db")).body.entries[0]).toMatchObject({ projectName: "Secret Plans" });
  });

  it("uses ADMIN_EMAILS when it's set", async () => {
    const app = createApp({
      connections: { secrets: createSecretBox(dataDir, "test-secret"), allowPrivateHosts: true },
      db: openDatabase(":memory:"),
      exportAccdb: createExporter(javaTool),
      importAccess: createImporter(javaTool),
      secureCookies: false,
      adminEmails: ["Boss@Example.com"],
    });
    const first = await signUp(app, "first@example.com");
    const boss = await signUp(app, "boss@example.com");
    expect((await first.get("/api/admin/overview")).status).toBe(404);
    expect((await boss.get("/api/admin/overview")).status).toBe(200);
  });
});

describe("usage policy and suspended accounts", () => {
  it("requires agreeing to the policy to register, and records the version", async () => {
    const app = makeApp();
    const r = await request(app).post("/api/auth/register").send({ email: "nope@example.com", name: "N", password: "correct horse" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Usage Policy/);
    const pol = (await request(app).get("/api/auth/policy")).body;
    expect(pol.version).toMatch(/^\d{4}-\d\d-\d\d$/);
    const a = await signUp(app, "yes@example.com");
    expect((await a.get("/api/auth/me")).body.user.needsPolicy).toBeUndefined();
  });

  it("asks people who haven't agreed to the current version, and blocks the app until they do", async () => {
    const db = openDatabase(":memory:");
    const app = createApp({
      connections: { secrets: createSecretBox(dataDir, "test-secret"), allowPrivateHosts: true },
      db,
      exportAccdb: createExporter(javaTool),
      importAccess: createImporter(javaTool),
      secureCookies: false,
    });
    const a = await signUp(app, "old@example.com");
    db.prepare("UPDATE users SET policy_version = NULL").run(); // registered before the policy
    expect((await a.get("/api/auth/me")).body.user.needsPolicy).toBe(true);
    const blocked = await a.get("/api/projects");
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("policy");
    expect((await a.post("/api/auth/accept-policy").send({ version: "1999-01-01" })).status).toBe(409);
    const { version } = (await a.get("/api/auth/policy")).body;
    const ok = await a.post("/api/auth/accept-policy").send({ version });
    expect(ok.body.user.needsPolicy).toBeUndefined();
    expect((await a.get("/api/projects")).status).toBe(200);
  });

  it("lets an admin suspend an account: signed out, can't sign in, its shared and public databases close; reinstating restores it", async () => {
    const app = makeApp();
    const admin = await signUp(app, "admin@example.com");
    const bad = await signUp(app, "bad@example.com");
    const friend = await signUp(app, "friend@example.com");
    const p = (await bad.post("/api/projects").send({ name: "Spam" })).body.project;
    await bad.put(`/api/projects/${p.id}/shares`).send({ email: "friend@example.com", permission: "view" });
    await bad.put(`/api/projects/${p.id}/public-access`).send({ publicView: true });
    expect((await request(app).get(`/api/public/${p.id}`)).status).toBe(200);
    const badId = (await bad.get("/api/auth/me")).body.user.id;

    expect((await admin.post(`/api/admin/users/${badId}/suspend`).send({ reason: "" })).status).toBe(400);
    expect((await admin.post(`/api/admin/users/${badId}/suspend`).send({ reason: "Phishing page in a public report" })).status).toBe(200);
    expect((await bad.get("/api/auth/me")).body.user).toBeNull();
    const login = await request(app).post("/api/auth/login").send({ email: "bad@example.com", password: "correct horse" });
    expect(login.status).toBe(403);
    expect(login.body.error).toMatch(/suspended/);
    expect((await friend.get(`/api/projects/${p.id}`)).status).toBe(404);
    expect((await friend.get("/api/projects")).body.shared).toHaveLength(0);
    expect((await request(app).get(`/api/public/${p.id}`)).status).toBe(404);

    const row = (await admin.get("/api/admin/users")).body.users.find((u: { email: string }) => u.email === "bad@example.com");
    expect(row).toMatchObject({ suspendedReason: "Phishing page in a public report" });
    expect(row.policyVersion).toMatch(/^\d{4}/);
    const log = (await admin.get("/api/admin/activity?action=suspend")).body.entries;
    expect(log[0]).toMatchObject({ email: "bad@example.com" });
    expect(log[0].detail).toContain("by admin@example.com");
    const adminId = (await admin.get("/api/auth/me")).body.user.id;
    expect((await admin.post(`/api/admin/users/${adminId}/suspend`).send({ reason: "x" })).status).toBe(400);

    expect((await admin.post(`/api/admin/users/${badId}/unsuspend`).send({})).status).toBe(200);
    expect((await request(app).post("/api/auth/login").send({ email: "bad@example.com", password: "correct horse" })).status).toBe(200);
    expect((await friend.get(`/api/projects/${p.id}`)).status).toBe(200);
  });
});

describe("plans: advanced features", () => {
  const plainApp = (billing?: Parameters<typeof createApp>[0]["billing"]) =>
    createApp({
      connections: { secrets: createSecretBox(dataDir, "test-secret"), allowPrivateHosts: true },
      db: openDatabase(":memory:"),
      exportAccdb: createExporter(javaTool),
      importAccess: createImporter(javaTool),
      secureCookies: false,
      billing,
    });

  it("leaves everything on until the admin requires a plan; then refuses advanced features unless enabled", async () => {
    const app = plainApp();
    const admin = await signUp(app, "admin@example.com");
    const pat = await signUp(app, "pat@example.com");
    await signUp(app, "sam@example.com");
    const p = (await pat.post("/api/projects").send({ name: "Club" })).body.project;
    // Off by default: sharing works.
    expect((await pat.put(`/api/projects/${p.id}/shares`).send({ email: "sam@example.com", permission: "view" })).status).toBe(200);
    expect((await pat.get("/api/billing/status")).body).toMatchObject({ gated: false, features: ["sharing", "public", "mysql", "accdb"], billing: false });

    // Require a plan, with Sharing and Public links advanced.
    expect((await admin.put("/api/admin/plans/settings").send({ gated: true, advanced: ["sharing", "public"] })).status).toBe(200);
    const refused = await pat.put(`/api/projects/${p.id}/shares`).send({ email: "admin@example.com", permission: "view" });
    expect(refused.status).toBe(402);
    expect(refused.body).toMatchObject({ code: "upgrade", feature: "sharing", yours: true });
    expect(refused.body.error).toMatch(/Advanced plan/);
    expect((await pat.put(`/api/projects/${p.id}/public-access`).send({ publicView: true })).status).toBe(402);
    // Turning things off is always allowed, and features that aren't advanced still work.
    expect((await pat.put(`/api/projects/${p.id}/link-access`).send({ linkAccess: "none" })).status).toBe(200);
    expect((await pat.get("/api/billing/status")).body.features).toEqual(["mysql", "accdb"]);
    // Admins always have everything.
    const mine = (await admin.post("/api/projects").send({ name: "Mine" })).body.project;
    expect((await admin.put(`/api/projects/${mine.id}/public-access`).send({ publicView: true })).status).toBe(200);

    // The admin enables Sharing for Pat.
    const plans = (await admin.get("/api/admin/plans")).body;
    expect(plans).toMatchObject({ gated: true, advanced: ["sharing", "public"] });
    expect(plans.stripe.configured).toBe(false);
    const patId = plans.users.find((u: { email: string }) => u.email === "pat@example.com").id;
    expect((await admin.post("/api/admin/plans/grant").send({ userIds: [patId], features: ["sharing"], enable: true })).body.changed).toBe(1);
    expect((await pat.put(`/api/projects/${p.id}/shares`).send({ email: "admin@example.com", permission: "view" })).status).toBe(200);
    expect((await pat.get("/api/billing/status")).body).toMatchObject({ granted: ["sharing"], features: ["sharing", "mysql", "accdb"] });

    // An editor of Pat's database is governed by Pat's plan, not their own.
    const sam = await request.agent(app);
    await sam.post("/api/auth/login").send({ email: "sam@example.com", password: "correct horse" });
    await pat.put(`/api/projects/${p.id}/shares`).send({ email: "sam@example.com", permission: "edit" });
    const bySam = await sam.put(`/api/projects/${p.id}/public-access`).send({ publicView: true });
    expect([402, 403]).toContain(bySam.status);

    // Disable again; logged.
    await admin.post("/api/admin/plans/grant").send({ userIds: [patId], features: ["sharing"], enable: false });
    expect((await pat.put(`/api/projects/${p.id}/shares`).send({ email: "admin@example.com", permission: "edit" })).status).toBe(402);
    const log = (await admin.get("/api/admin/activity?action=features_change")).body.entries;
    expect(log.map((e: { detail: string }) => e.detail)).toEqual([expect.stringContaining("disabled sharing"), expect.stringContaining("enabled sharing")]);
    expect((await pat.post("/api/admin/plans/grant").send({ userIds: [patId], features: ["sharing"], enable: true })).status).toBe(404);
  });

  it("subscribes through Stripe Checkout ($0 test plan), confirms on return, and follows webhooks", async () => {
    const stripe = new Stripe("sk_test_fake");
    let checkoutParams: Record<string, unknown> | null = null;
    let userId = "";
    const sub = (status: string) => ({ id: "sub_1", status, customer: "cus_1", cancel_at_period_end: false, metadata: { userId }, items: { data: [{ current_period_end: 1893456000 }] } });
    const price = { id: "price_free", unit_amount: 0, currency: "usd", recurring: { interval: "month", interval_count: 1 } };
    Object.assign(stripe.products, { create: async () => ({ id: "prod_1" }) });
    Object.assign(stripe.prices, { create: async () => price, retrieve: async () => price });
    Object.assign(stripe.checkout.sessions, {
      create: async (params: Record<string, unknown>) => ((checkoutParams = params), { url: "https://checkout.stripe.test/c/1" }),
      retrieve: async () => ({ client_reference_id: userId, status: "complete", subscription: sub("active") }),
    });
    Object.assign(stripe.subscriptions, { retrieve: async () => sub("active") });
    Object.assign(stripe.billingPortal.sessions, { create: async () => ({ url: "https://billing.stripe.test/p/1" }) });

    const app = plainApp({ stripe, webhookSecret: "whsec_test", priceId: null, mode: "test" });
    const admin = await signUp(app, "admin@example.com");
    const pat = await signUp(app, "pat@example.com");
    userId = (await pat.get("/api/auth/me")).body.user.id;
    await admin.put("/api/admin/plans/settings").send({ gated: true, advanced: ["sharing", "public", "mysql", "accdb"] });
    expect((await pat.get("/api/billing/status")).body).toMatchObject({ billing: true, features: [], plan: null });

    const start = await pat.post("/api/billing/checkout").set("Origin", "http://example.test").send({ returnTo: "/?db=abc" });
    expect(start.body.url).toBe("https://checkout.stripe.test/c/1");
    expect(checkoutParams).toMatchObject({ mode: "subscription", payment_method_collection: "if_required", client_reference_id: userId, line_items: [{ price: "price_free", quantity: 1 }] });
    expect(String((checkoutParams as unknown as { success_url: string }).success_url)).toContain("billing=done&session_id={CHECKOUT_SESSION_ID}");

    const done = await pat.post("/api/billing/confirm").send({ sessionId: "cs_test_1" });
    expect(done.body).toMatchObject({ plan: { status: "active", cancelAtPeriodEnd: false }, features: ["sharing", "public", "mysql", "accdb"], price: "$0.00 / month" });
    expect((await pat.post("/api/billing/portal").send({})).body.url).toBe("https://billing.stripe.test/p/1");
    expect((await admin.get("/api/admin/plans")).body.users.find((u: { id: string }) => u.id === userId).planStatus).toBe("active");

    // Stripe says the subscription ended: back to Free.
    const payload = JSON.stringify({ id: "evt_1", object: "event", type: "customer.subscription.deleted", data: { object: sub("canceled") } });
    const bad = await request(app).post("/api/billing/webhook").set("Content-Type", "application/json").set("Stripe-Signature", "t=1,v1=nope").send(payload);
    expect(bad.status).toBe(400);
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_test" });
    expect((await request(app).post("/api/billing/webhook").set("Content-Type", "application/json").set("Stripe-Signature", sig).send(payload)).status).toBe(200);
    expect((await pat.get("/api/billing/status")).body).toMatchObject({ plan: { status: "canceled" }, features: [] });
    const changes = (await admin.get("/api/admin/activity?action=plan_change")).body.entries.map((e: { detail: string }) => e.detail);
    expect(changes).toEqual(["active → canceled", "free → active"]);
    expect((await admin.get("/api/admin/plans")).body.stripe).toMatchObject({ configured: true, mode: "test", priceId: "price_free", webhookSecret: true });
  });
});
