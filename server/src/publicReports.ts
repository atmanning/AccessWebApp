/**
 * Public report links. The owner makes a report public; anyone with its link can then see it
 * without signing in. The link serves a copy of only what that report shows (its columns and
 * rows), never the database document, so the rest of the data stays private. Editors' browsers
 * refresh the copy when the data changes.
 */
import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import type { DB } from "./db.js";
import { requireUser } from "./auth.js";
import { httpError, projectLoader } from "./projects.js";
import { IMAGE_ID, projectDocSchema, type ProjectDoc } from "../../shared/model.js";
import { applyScan, keyField, mayRecord, personName, scanStatus } from "../../shared/scan.js";

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

const cell = z.union([z.string().max(100_000), z.number(), z.boolean(), z.null()]);
export const snapshotSchema = z.object({
  v: z.literal(1),
  title: z.string().max(200),
  /** The report's own settings (columns, grouping, sorting, labels layout). */
  report: z.record(z.string(), z.unknown()),
  columns: z.array(z.string().max(200)).max(255),
  /** Each column's data type and display settings (or null), for formatting. */
  fields: z.array(z.record(z.string(), z.unknown()).nullable()).max(255),
  rows: z.array(z.array(cell).max(256)).max(50_000),
  /** Labels with QR codes: each row's link. */
  qr: z.array(z.string().max(2000)).max(50_000).optional(),
});

type Row = { token: string; project_id: string; report_id: string; snapshot: string; created_at: string; updated_at: string };

/** Pictures a snapshot shows (its Image columns' values). */
function snapshotImages(snap: z.infer<typeof snapshotSchema>): Set<string> {
  const cols = snap.fields.map((f, i) => (f?.type === "Image" ? i : -1)).filter((i) => i >= 0);
  const ids = new Set<string>();
  for (const r of snap.rows) for (const i of cols) if (typeof r[i] === "string" && IMAGE_ID.test(r[i] as string)) ids.add(r[i] as string);
  return ids;
}

/** Signed-in routes, under /api/projects/:id/public-reports. */
export function publicReportsRouter(db: DB) {
  const router = Router({ mergeParams: true });
  router.use(requireUser);
  const load = projectLoader(db);
  const pid = (req: { params: Record<string, string> }) => req.params.id;

  // Which reports are public (anyone who can view the database may see the list).
  router.get("/", (req, res) => {
    const { row } = load(pid(req), req.user!.id);
    const rows = db.prepare("SELECT token, report_id, updated_at FROM public_reports WHERE project_id = ?").all(row.id) as Row[];
    res.json({ reports: rows.map((r) => ({ reportId: r.report_id, token: r.token, updatedAt: r.updated_at })) });
  });

  // Make a report public (owner), or refresh its copy (owner or editor).
  router.put("/:reportId", (req, res) => {
    const reportId = z.string().max(64).parse(req.params.reportId);
    const existing = db.prepare("SELECT * FROM public_reports WHERE project_id = ? AND report_id = ?").get(pid(req), reportId) as Row | undefined;
    const { row } = load(pid(req), req.user!.id, existing ? "edit" : "owner");
    const doc = JSON.parse(row.doc) as ProjectDoc;
    if (!doc.reports.some((r) => r.id === reportId)) throw httpError(404, "That report doesn't exist any more.");
    const snapshot = snapshotSchema.parse(req.body?.snapshot);
    const text = JSON.stringify(snapshot);
    if (text.length > MAX_SNAPSHOT_BYTES) throw httpError(413, "This report has too many records to share publicly (the limit is about 8 MB). Try a query that shows fewer.");
    const now = new Date().toISOString();
    if (existing) {
      db.prepare("UPDATE public_reports SET snapshot = ?, updated_at = ? WHERE token = ?").run(text, now, existing.token);
      return void res.json({ token: existing.token, updatedAt: now });
    }
    const token = crypto.randomBytes(18).toString("base64url");
    db.prepare("INSERT INTO public_reports (token, project_id, report_id, snapshot, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      token,
      row.id,
      reportId,
      text,
      req.user!.id,
      now,
      now,
    );
    res.json({ token, updatedAt: now });
  });

  // Stop sharing (owner). The old link stops working; sharing again makes a new one.
  router.delete("/:reportId", (req, res) => {
    const { row } = load(pid(req), req.user!.id, "owner");
    db.prepare("DELETE FROM public_reports WHERE project_id = ? AND report_id = ?").run(row.id, req.params.reportId);
    res.json({ ok: true });
  });

  return router;
}

/** Public routes, under /api/public-reports: no sign-in (except recording, below). */
export function publicReportsReadRouter(db: DB) {
  const router = Router();
  const load = projectLoader(db);
  /** The signed-in person's role in the report's database, or null (no access is fine here). */
  const roleIn = (projectId: string, userId: string | undefined) => {
    if (!userId) return null;
    try {
      return load(projectId, userId).role;
    } catch {
      return null;
    }
  };
  const docOf = (projectId: string) => JSON.parse((db.prepare("SELECT doc FROM projects WHERE id = ?").get(projectId) as { doc: string }).doc) as ProjectDoc;
  /** Actions for people whose key is `key` (the field named in the tag's code). */
  const actionsFor = (doc: ProjectDoc, key: string) =>
    (doc.scanActions ?? []).filter((a) => {
      const people = doc.tables.find((t) => t.id === a.people);
      return keyField(people)?.name.toLowerCase() === key.toLowerCase();
    });
  const find = (token: string) => {
    const row = /^[A-Za-z0-9_-]{16,64}$/.test(token) ? (db.prepare("SELECT * FROM public_reports WHERE token = ?").get(token) as Row | undefined) : undefined;
    if (!row) throw httpError(404, "This report isn't shared publicly any more. Ask the person who sent the link for a new one.");
    return row;
  };
  router.get("/:token", (req, res) => {
    const row = find(req.params.token);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex");
    res.json({ snapshot: JSON.parse(row.snapshot), updatedAt: row.updated_at });
  });
  /**
   * Opened from a name tag by someone signed in: what they may record for that person (Take
   * attendance…). Signed out, or not allowed: nothing (the public report is all they get).
   */
  router.get("/:token/record", (req, res) => {
    const row = find(req.params.token);
    res.setHeader("Cache-Control", "no-store");
    const key = String(req.query.key ?? "");
    const rec = String(req.query.rec ?? "");
    if (!req.user) return void res.json({ signedIn: false, actions: [] });
    const doc = docOf(row.project_id);
    const role = roleIn(row.project_id, req.user.id);
    const actions = actionsFor(doc, key).filter((a) => mayRecord(a, req.user!, role));
    if (!actions.length || !rec) return void res.json({ signedIn: true, actions: [] });
    const people = doc.tables.find((t) => t.id === actions[0].people)!;
    const pk = keyField(people)!;
    const person = people.rows.find((r) => String(r[pk.id] ?? "").toLowerCase() === rec.toLowerCase());
    res.json({
      signedIn: true,
      person: person ? personName(people, person) : null,
      actions: person ? actions.map((a) => ({ id: a.id, name: a.name, done: scanStatus(doc, a, rec) })) : [],
    });
  });

  /** Records it: the server applies the action to the database and saves it (so several scanners can work at once). */
  router.post("/:token/record", requireUser, (req, res) => {
    const row = find(String(req.params.token));
    const body = z
      .object({ actionId: z.string().max(64), key: z.string().max(64), rec: z.string().max(200), now: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/).optional() })
      .parse(req.body);
    // The phone's own date and time (the server runs on UTC), if it's within a day of the server's.
    const now = body.now && Math.abs(Date.parse(`${body.now}Z`) - Date.now()) < 36 * 3600_000 ? body.now.slice(0, 19) : new Date().toISOString().slice(0, 19);
    const result = db.transaction(() => {
      const p = db.prepare("SELECT doc, revision FROM projects WHERE id = ?").get(row.project_id) as { doc: string; revision: number };
      const doc = JSON.parse(p.doc) as ProjectDoc;
      const action = actionsFor(doc, body.key).find((a) => a.id === body.actionId);
      if (!action || !mayRecord(action, req.user!, roleIn(row.project_id, req.user!.id))) {
        throw httpError(403, "You can't record this. Ask the database's owner to add you to the scan action's \"Who can record\" list.");
      }
      const r = applyScan(doc, action, body.rec, now);
      if (r.ok) {
        projectDocSchema.parse(doc);
        db.prepare("UPDATE projects SET doc = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(
          JSON.stringify(doc),
          p.revision + 1,
          new Date().toISOString(),
          req.user!.id,
          row.project_id,
        );
      }
      return r;
    })();
    res.json(result.ok ? { ok: true, person: result.person, message: result.message } : result);
  });

  // Only pictures the report shows.
  router.get("/:token/images/:imageId", (req, res) => {
    const row = find(req.params.token);
    const imageId = req.params.imageId;
    if (!snapshotImages(JSON.parse(row.snapshot)).has(imageId)) throw httpError(404, "Picture not found.");
    const img = db.prepare("SELECT mime, data FROM images WHERE project_id = ? AND id = ?").get(row.project_id, imageId) as { mime: string; data: Buffer } | undefined;
    if (!img) throw httpError(404, "Picture not found.");
    res.setHeader("Content-Type", img.mime);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.send(img.data);
  });
  return router;
}

/** Reports deleted from a database stop being public. */
export function removeOrphanPublicReports(db: DB, projectId: string, doc: string) {
  const ids = new Set((JSON.parse(doc) as ProjectDoc).reports.map((r) => r.id));
  const rows = db.prepare("SELECT token, report_id FROM public_reports WHERE project_id = ?").all(projectId) as Row[];
  for (const r of rows) if (!ids.has(r.report_id)) db.prepare("DELETE FROM public_reports WHERE token = ?").run(r.token);
}
