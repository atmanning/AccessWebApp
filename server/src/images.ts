/**
 * Pictures for Image fields. They're stored here rather than in the database document (which is
 * saved whole on every change), and a cell holds the picture's id. Anyone who can view the
 * database can see its pictures; editors can add them.
 */
import express, { Router, type Response } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import type { DB } from "./db.js";
import { requireUser } from "./auth.js";
import { httpError, projectLoader } from "./projects.js";
import { IMAGE_ID, IMAGE_ID_ANYWHERE, MAX_IMAGE_BYTES } from "../../shared/model.js";

/** Recognises a picture by its first bytes (the browser's Content-Type isn't trusted). */
export function imageType(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export interface ImageOptions {
  /** Total picture storage allowed per database, in bytes. */
  maxBytesPerProject: number;
}

function send(res: Response, row: { mime: string; data: Buffer } | undefined) {
  if (!row) throw httpError(404, "Picture not found.");
  res.setHeader("Content-Type", row.mime);
  // An id always means the same picture, so browsers can keep it.
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.send(row.data);
}

export function imagesRouter(db: DB, opts: ImageOptions) {
  const router = Router({ mergeParams: true });
  router.use(requireUser);
  const load = projectLoader(db);
  const getImage = db.prepare("SELECT mime, data FROM images WHERE project_id = ? AND id = ?");

  router.post("/", express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }), (req, res) => {
    const { row } = load((req.params as unknown as { id: string }).id, req.user!.id, "edit");
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) throw httpError(400, "Choose a picture to add.");
    const mime = imageType(body);
    if (!mime) throw httpError(400, "That file isn't a picture Access Web can store. Use PNG, JPEG, GIF or WebP.");
    const used = (db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM images WHERE project_id = ?").get(row.id) as { n: number }).n;
    if (used + body.length > opts.maxBytesPerProject) {
      throw httpError(400, `This database's pictures would take more than ${Math.round(opts.maxBytesPerProject / 1048576)} MB. Remove some pictures first.`);
    }
    const id = `img_${crypto.randomBytes(16).toString("hex")}`;
    db.prepare("INSERT INTO images (project_id, id, mime, size, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      row.id,
      id,
      mime,
      body.length,
      body,
      req.user!.id,
      new Date().toISOString(),
    );
    res.status(201).json({ id, mime, size: body.length });
  });

  /** Copies pictures from another database the caller can view (when pasting or importing objects). */
  router.post("/copy", (req, res) => {
    const { row } = load((req.params as unknown as { id: string }).id, req.user!.id, "edit");
    const body = z.object({ from: z.string().min(1).max(100), ids: z.array(z.string().regex(IMAGE_ID)).max(10_000) }).parse(req.body);
    const source = load(body.from, req.user!.id).row;
    const insert = db.prepare(
      `INSERT OR IGNORE INTO images (project_id, id, mime, size, data, created_by, created_at)
       SELECT ?, id, mime, size, data, ?, ? FROM images WHERE project_id = ? AND id = ?`,
    );
    let copied = 0;
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const id of new Set(body.ids)) copied += insert.run(row.id, req.user!.id, now, source.id, id).changes;
    })();
    res.json({ copied });
  });

  router.get("/:imageId", (req, res) => {
    const { row } = load((req.params as unknown as { id: string }).id, req.user!.id);
    if (!IMAGE_ID.test(req.params.imageId)) throw httpError(404, "Picture not found.");
    send(res, getImage.get(row.id, req.params.imageId) as { mime: string; data: Buffer } | undefined);
  });

  return router;
}

/** Pictures of databases published for public viewing (no sign-in). */
export function publicImagesRouter(db: DB) {
  const router = Router({ mergeParams: true });
  router.get("/:imageId", (req, res) => {
    const id = (req.params as unknown as { id: string }).id;
    const published = db.prepare("SELECT 1 FROM projects WHERE id = ? AND public_view = 1").get(id);
    if (!published || !IMAGE_ID.test(req.params.imageId)) throw httpError(404, "Picture not found.");
    send(res, db.prepare("SELECT mime, data FROM images WHERE project_id = ? AND id = ?").get(id, req.params.imageId) as { mime: string; data: Buffer } | undefined);
  });
  return router;
}

/**
 * Deletes a database's pictures that its document no longer mentions. Pictures less than a day old
 * are kept, so undoing a change (or a save racing an upload) can't lose one.
 */
export function removeUnusedImages(db: DB, projectId: string, docJson: string) {
  const used = new Set(docJson.match(IMAGE_ID_ANYWHERE) ?? []);
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const old = db.prepare("SELECT id FROM images WHERE project_id = ? AND created_at < ?").all(projectId, cutoff) as { id: string }[];
  const del = db.prepare("DELETE FROM images WHERE project_id = ? AND id = ?");
  db.transaction(() => {
    for (const { id } of old) if (!used.has(id)) del.run(projectId, id);
  })();
}

/** Copies a database's pictures to its copy (Save a copy keeps the same ids). */
export function copyImages(db: DB, fromProject: string, toProject: string) {
  db.prepare(
    "INSERT INTO images (project_id, id, mime, size, data, created_by, created_at) SELECT ?, id, mime, size, data, created_by, created_at FROM images WHERE project_id = ?",
  ).run(toProject, fromProject);
}
