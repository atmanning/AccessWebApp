import express, { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import type { DB } from "./db.js";
import { requireUser } from "./auth.js";
import {
  checkProjectIntegrity,
  nameSchema,
  projectDocSchema,
  type ProjectDoc,
  type ProjectRecord,
  type ProjectSummary,
} from "../../shared/model.js";
import { buildTemplate, TEMPLATES, type TemplateId } from "../../shared/templates.js";

interface ProjectRow {
  id: string;
  name: string;
  doc: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

const MAX_PROJECTS_PER_USER = 200;

const createSchema = z.object({
  name: nameSchema,
  template: z.enum(Object.keys(TEMPLATES) as [TemplateId, ...TemplateId[]]).default("blank"),
});
const updateSchema = z.object({
  name: nameSchema.optional(),
  doc: projectDocSchema.optional(),
  /** The revision the client last loaded; protects against overwriting edits from another tab. */
  baseRevision: z.number().int(),
});

function summarize(row: ProjectRow, doc?: ProjectDoc): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
    tableCount: (doc ?? (JSON.parse(row.doc) as ProjectDoc)).tables.length,
  };
}

export function safeFileName(name: string) {
  return name.replace(/[^\w\- ]+/g, "_").trim() || "Database";
}

export type ImportAccess = (file: Buffer) => Promise<{ doc: ProjectDoc; warnings: string[] }>;

/** Uploaded Access files arrive as raw bytes (application/octet-stream). */
const accessUpload = express.raw({ type: () => true, limit: "100mb" });

export function projectsRouter(db: DB, exportAccdb: (doc: ProjectDoc) => Promise<Buffer>, importAccess: ImportAccess) {
  const router = Router();
  router.use(requireUser);

  const projectCount = (userId: string) =>
    (db.prepare("SELECT COUNT(*) AS n FROM projects WHERE user_id = ?").get(userId) as { n: number }).n;

  const insertProject = (userId: string, name: string, doc: ProjectDoc): ProjectRecord => {
    const now = new Date().toISOString();
    const row: ProjectRow = { id: crypto.randomUUID(), name, doc: JSON.stringify(doc), revision: 1, created_at: now, updated_at: now };
    db.prepare(
      "INSERT INTO projects (id, user_id, name, doc, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(row.id, userId, row.name, row.doc, row.revision, row.created_at, row.updated_at);
    return { ...summarize(row, doc), doc };
  };

  const uploadedFile = (body: unknown) => {
    if (!Buffer.isBuffer(body) || body.length === 0) throw Object.assign(new Error("Choose an Access file to upload."), { status: 400 });
    return body;
  };

  /** Creates a new database from an uploaded .accdb/.mdb file. */
  router.post("/import-access", accessUpload, async (req, res) => {
    const name = nameSchema.parse(String(req.query.name ?? ""));
    if (projectCount(req.user!.id) >= MAX_PROJECTS_PER_USER) {
      res.status(400).json({ error: `You can have up to ${MAX_PROJECTS_PER_USER} databases. Delete one to make room.` });
      return;
    }
    const { doc, warnings } = await importAccess(uploadedFile(req.body));
    res.status(201).json({ project: insertProject(req.user!.id, name, doc), warnings });
  });

  /** Reads an uploaded .accdb/.mdb and returns its objects without saving, for importing into an open database. */
  router.post("/convert-access", accessUpload, async (req, res) => {
    res.json(await importAccess(uploadedFile(req.body)));
  });

  const getOwned = (id: string, userId: string) =>
    db.prepare("SELECT * FROM projects WHERE id = ? AND user_id = ?").get(id, userId) as ProjectRow | undefined;

  router.get("/", (req, res) => {
    const rows = db
      .prepare("SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC")
      .all(req.user!.id) as ProjectRow[];
    res.json({ projects: rows.map((r) => summarize(r)) });
  });

  router.post("/", (req, res) => {
    const body = createSchema.parse(req.body);
    if (projectCount(req.user!.id) >= MAX_PROJECTS_PER_USER) {
      res.status(400).json({ error: `You can have up to ${MAX_PROJECTS_PER_USER} databases. Delete one to make room.` });
      return;
    }
    res.status(201).json({ project: insertProject(req.user!.id, body.name, buildTemplate(body.template)) });
  });

  router.get("/:id", (req, res) => {
    const row = getOwned(req.params.id, req.user!.id);
    if (!row) {
      res.status(404).json({ error: "Database not found." });
      return;
    }
    const doc = JSON.parse(row.doc) as ProjectDoc;
    res.json({ project: { ...summarize(row, doc), doc } satisfies ProjectRecord });
  });

  router.put("/:id", (req, res) => {
    const body = updateSchema.parse(req.body);
    const row = getOwned(req.params.id, req.user!.id);
    if (!row) {
      res.status(404).json({ error: "Database not found." });
      return;
    }
    if (row.revision !== body.baseRevision) {
      res.status(409).json({
        error: "This database was changed in another window. Reload to get the latest version.",
        revision: row.revision,
      });
      return;
    }
    if (body.doc) {
      const problems = checkProjectIntegrity(body.doc);
      if (problems.length) {
        res.status(400).json({ error: problems[0], problems });
        return;
      }
    }
    const next: ProjectRow = {
      ...row,
      name: body.name ?? row.name,
      doc: body.doc ? JSON.stringify(body.doc) : row.doc,
      revision: row.revision + 1,
      updated_at: new Date().toISOString(),
    };
    const result = db
      .prepare("UPDATE projects SET name = ?, doc = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?")
      .run(next.name, next.doc, next.revision, next.updated_at, row.id, row.revision);
    if (result.changes === 0) {
      res.status(409).json({ error: "This database was changed in another window. Reload to get the latest version." });
      return;
    }
    res.json({ project: summarize(next, body.doc) });
  });

  router.delete("/:id", (req, res) => {
    const result = db.prepare("DELETE FROM projects WHERE id = ? AND user_id = ?").run(req.params.id, req.user!.id);
    if (result.changes === 0) {
      res.status(404).json({ error: "Database not found." });
      return;
    }
    res.json({ ok: true });
  });

  router.get("/:id/export.accdb", async (req, res) => {
    const row = getOwned(req.params.id, req.user!.id);
    if (!row) {
      res.status(404).json({ error: "Database not found." });
      return;
    }
    const bytes = await exportAccdb(JSON.parse(row.doc) as ProjectDoc);
    const file = `${safeFileName(row.name)}.accdb`;
    res.setHeader("Content-Type", "application/msaccess");
    res.setHeader("Content-Disposition", `attachment; filename="${file}"; filename*=UTF-8''${encodeURIComponent(file)}`);
    res.setHeader("Cache-Control", "no-store");
    res.send(bytes);
  });

  return router;
}
