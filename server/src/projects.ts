import express, { Router, type Response } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import type { DB } from "./db.js";
import { requireUser } from "./auth.js";
import {
  checkProjectIntegrity,
  nameSchema,
  projectDocSchema,
  type LinkAccess,
  type ProjectDoc,
  type ProjectRecord,
  type ProjectRole,
  type ProjectSummary,
  type ShareSettings,
} from "../../shared/model.js";
import { buildTemplate, TEMPLATES, type TemplateId } from "../../shared/templates.js";
import { copyImages, removeUnusedImages } from "./images.js";

interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  doc: string;
  revision: number;
  created_at: string;
  updated_at: string;
  link_access: LinkAccess;
  updated_by: string | null;
  public_view: number;
}

/** A project row joined with what the summary needs. */
interface ProjectListRow extends ProjectRow {
  owner_name: string;
  updated_by_name: string | null;
  role?: ProjectRole;
}

const MAX_PROJECTS_PER_USER = 200;
const MAX_SHARES_PER_PROJECT = 100;

const createSchema = z.object({
  name: nameSchema,
  template: z.enum(Object.keys(TEMPLATES) as [TemplateId, ...TemplateId[]]).default("blank"),
});
const updateSchema = z.object({
  name: nameSchema.optional(),
  doc: projectDocSchema.optional(),
  /** The revision the client last loaded; protects against overwriting someone else's newer save. */
  baseRevision: z.number().int(),
});
const shareSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(254),
  permission: z.enum(["view", "edit"]),
});
const linkSchema = z.object({ linkAccess: z.enum(["none", "view", "edit"]) });
const publicSchema = z.object({ publicView: z.boolean() });
const copySchema = z.object({ name: nameSchema });

export const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

function summarize(row: ProjectListRow, role: ProjectRole, doc?: ProjectDoc): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
    tableCount: (doc ?? (JSON.parse(row.doc) as ProjectDoc)).tables.length,
    role,
    ownerName: row.owner_name,
    ...(row.updated_by && row.updated_by !== row.user_id && row.updated_by_name ? { updatedByName: row.updated_by_name } : {}),
  };
}

export function safeFileName(name: string) {
  return name.replace(/[^\w\- ]+/g, "_").trim() || "Database";
}

export type ImportAccess = (file: Buffer) => Promise<{ doc: ProjectDoc; warnings: string[] }>;

/** Uploaded Access files arrive as raw bytes (application/octet-stream). */
const accessUpload = express.raw({ type: () => true, limit: "100mb" });

const SELECT_PROJECT = `
  SELECT p.*, o.name AS owner_name, u.name AS updated_by_name
  FROM projects p
  JOIN users o ON o.id = p.user_id
  LEFT JOIN users u ON u.id = p.updated_by`;

/**
 * Loads a project and the caller's role on it. Unknown projects and ones the caller can't see
 * both return 404, so project ids can't be probed.
 */
export function projectLoader(db: DB) {
  return (id: string, userId: string, need: "view" | "edit" | "owner" = "view") => {
    const row = db.prepare(`${SELECT_PROJECT} WHERE p.id = ?`).get(id) as ProjectListRow | undefined;
    if (!row) throw httpError(404, "Database not found.");
    let role: ProjectRole | null = null;
    if (row.user_id === userId) role = "owner";
    else {
      const share = db.prepare("SELECT permission FROM project_shares WHERE project_id = ? AND user_id = ?").get(id, userId) as
        | { permission: "view" | "edit" }
        | undefined;
      const perms = [share?.permission, row.link_access === "none" ? undefined : row.link_access];
      role = perms.includes("edit") ? "edit" : perms.includes("view") ? "view" : null;
    }
    if (!role) throw httpError(404, "Database not found.");
    if (need === "owner" && role !== "owner") throw httpError(403, "Only the owner can do that.");
    if (need === "edit" && role === "view") throw httpError(403, "You have view-only access to this database.");
    return { row, role };
  };
}

export function projectsRouter(db: DB, exportAccdb: (doc: ProjectDoc) => Promise<Buffer>, importAccess: ImportAccess) {
  const router = Router();
  router.use(requireUser);

  const projectCount = (userId: string) =>
    (db.prepare("SELECT COUNT(*) AS n FROM projects WHERE user_id = ?").get(userId) as { n: number }).n;

  const ensureRoom = (userId: string) => {
    if (projectCount(userId) >= MAX_PROJECTS_PER_USER) {
      throw httpError(400, `You can have up to ${MAX_PROJECTS_PER_USER} databases. Delete one to make room.`);
    }
  };

  const insertProject = (userId: string, name: string, doc: ProjectDoc): ProjectRecord => {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO projects (id, user_id, name, doc, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
    ).run(id, userId, name, JSON.stringify(doc), now, now);
    const row = db.prepare(`${SELECT_PROJECT} WHERE p.id = ?`).get(id) as ProjectListRow;
    return { ...summarize(row, "owner", doc), doc };
  };

  const load = projectLoader(db);

  const uploadedFile = (body: unknown) => {
    if (!Buffer.isBuffer(body) || body.length === 0) throw httpError(400, "Choose an Access file to upload.");
    return body;
  };

  // ---- Listing and creating ------------------------------------------------------------

  router.get("/", (req, res) => {
    const userId = req.user!.id;
    const owned = db.prepare(`${SELECT_PROJECT} WHERE p.user_id = ? ORDER BY p.updated_at DESC`).all(userId) as ProjectListRow[];
    // Shared with me: explicit shares, plus link-shared databases I've opened (while the link still works).
    const shared = db
      .prepare(
        `${SELECT_PROJECT}
         LEFT JOIN project_shares s ON s.project_id = p.id AND s.user_id = @user
         LEFT JOIN project_opens v ON v.project_id = p.id AND v.user_id = @user
         WHERE p.user_id != @user AND (s.user_id IS NOT NULL OR (v.user_id IS NOT NULL AND p.link_access != 'none'))
         ORDER BY p.updated_at DESC`,
      )
      .all({ user: userId }) as (ProjectListRow & { permission?: string })[];
    res.json({
      projects: owned.map((r) => summarize(r, "owner")),
      shared: shared.map((r) => summarize(r, load(r.id, userId).role)),
    });
  });

  router.post("/", (req, res) => {
    const body = createSchema.parse(req.body);
    ensureRoom(req.user!.id);
    res.status(201).json({ project: insertProject(req.user!.id, body.name, buildTemplate(body.template)) });
  });

  /** Creates a new database from an uploaded .accdb/.mdb file. */
  router.post("/import-access", accessUpload, async (req, res) => {
    const name = nameSchema.parse(String(req.query.name ?? ""));
    ensureRoom(req.user!.id);
    const { doc, warnings } = await importAccess(uploadedFile(req.body));
    res.status(201).json({ project: insertProject(req.user!.id, name, doc), warnings });
  });

  /** Reads an uploaded .accdb/.mdb and returns its objects without saving, for importing into an open database. */
  router.post("/convert-access", accessUpload, async (req, res) => {
    res.json(await importAccess(uploadedFile(req.body)));
  });

  // ---- One database --------------------------------------------------------------------

  router.get("/:id", (req, res) => {
    const userId = req.user!.id;
    const { row, role } = load(req.params.id, userId);
    if (role !== "owner") {
      db.prepare(
        "INSERT INTO project_opens (user_id, project_id, opened_at) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET opened_at = excluded.opened_at",
      ).run(userId, row.id, new Date().toISOString());
    }
    const doc = JSON.parse(row.doc) as ProjectDoc;
    res.json({ project: { ...summarize(row, role, doc), doc } satisfies ProjectRecord });
  });

  /** Cheap check for newer saves by other people, polled by open workspaces. */
  router.get("/:id/revision", (req, res) => {
    const { row } = load(req.params.id, req.user!.id);
    res.json({ revision: row.revision, updatedByName: row.updated_by_name, updatedAt: row.updated_at });
  });

  router.put("/:id", (req, res) => {
    const body = updateSchema.parse(req.body);
    const userId = req.user!.id;
    const { row } = load(req.params.id, userId, body.name !== undefined ? "owner" : "edit");
    const conflict = (res: Response) =>
      res.status(409).json({
        error: row.updated_by && row.updated_by !== userId && row.updated_by_name
          ? `${row.updated_by_name} saved changes to this database. Reload to get the latest version.`
          : "This database was changed in another window. Reload to get the latest version.",
        revision: row.revision,
      });
    if (row.revision !== body.baseRevision) return void conflict(res);
    if (body.doc) {
      const problems = checkProjectIntegrity(body.doc);
      if (problems.length) {
        res.status(400).json({ error: problems[0], problems });
        return;
      }
    }
    const next = {
      name: body.name ?? row.name,
      doc: body.doc ? JSON.stringify(body.doc) : row.doc,
      revision: row.revision + 1,
      updated_at: new Date().toISOString(),
    };
    const result = db
      .prepare("UPDATE projects SET name = ?, doc = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ? AND revision = ?")
      .run(next.name, next.doc, next.revision, next.updated_at, userId, row.id, row.revision);
    if (result.changes === 0) return void conflict(res);
    if (body.doc) removeUnusedImages(db, row.id, next.doc);
    const saved = db.prepare(`${SELECT_PROJECT} WHERE p.id = ?`).get(row.id) as ProjectListRow;
    res.json({ project: summarize(saved, load(row.id, userId).role, body.doc) });
  });

  /** Owners delete the database; anyone else just removes it from their Shared with me list. */
  router.delete("/:id", (req, res) => {
    const userId = req.user!.id;
    const { row, role } = load(req.params.id, userId);
    if (role === "owner") db.prepare("DELETE FROM projects WHERE id = ?").run(row.id);
    else {
      db.prepare("DELETE FROM project_shares WHERE project_id = ? AND user_id = ?").run(row.id, userId);
      db.prepare("DELETE FROM project_opens WHERE project_id = ? AND user_id = ?").run(row.id, userId);
    }
    res.json({ ok: true, removedOnly: role !== "owner" });
  });

  /** Save a copy: anyone who can view a database can make their own copy of it. */
  router.post("/:id/copy", (req, res) => {
    const { name } = copySchema.parse(req.body);
    const { row } = load(req.params.id, req.user!.id);
    ensureRoom(req.user!.id);
    const project = insertProject(req.user!.id, name, JSON.parse(row.doc) as ProjectDoc);
    copyImages(db, row.id, project.id);
    res.status(201).json({ project });
  });

  router.get("/:id/export.accdb", async (req, res) => {
    const { row } = load(req.params.id, req.user!.id);
    const bytes = await exportAccdb(JSON.parse(row.doc) as ProjectDoc);
    const file = `${safeFileName(row.name)}.accdb`;
    res.setHeader("Content-Type", "application/msaccess");
    res.setHeader("Content-Disposition", `attachment; filename="${file}"; filename*=UTF-8''${encodeURIComponent(file)}`);
    res.setHeader("Cache-Control", "no-store");
    res.send(bytes);
  });

  // ---- Sharing (owner only) ---------------------------------------------------------------

  const shareSettings = (projectId: string): ShareSettings => {
    const row = db.prepare("SELECT link_access, public_view FROM projects WHERE id = ?").get(projectId) as { link_access: LinkAccess; public_view: number };
    const shares = db
      .prepare(
        `SELECT u.id AS userId, u.email, u.name, s.permission FROM project_shares s JOIN users u ON u.id = s.user_id
         WHERE s.project_id = ? ORDER BY u.name COLLATE NOCASE`,
      )
      .all(projectId) as ShareSettings["shares"];
    return { linkAccess: row.link_access, publicView: !!row.public_view, shares };
  };

  router.get("/:id/shares", (req, res) => {
    const { row } = load(req.params.id, req.user!.id, "owner");
    res.json(shareSettings(row.id));
  });

  /** Shares with a registered user by email, or changes their permission. */
  router.put("/:id/shares", (req, res) => {
    const { row } = load(req.params.id, req.user!.id, "owner");
    const body = shareSchema.parse(req.body);
    const target = db.prepare("SELECT id FROM users WHERE email = ?").get(body.email) as { id: string } | undefined;
    if (!target) {
      throw httpError(404, `No one has registered with ${body.email} yet. Ask them to create an account, then share again.`);
    }
    if (target.id === row.user_id) throw httpError(400, "You already own this database.");
    const count = (db.prepare("SELECT COUNT(*) AS n FROM project_shares WHERE project_id = ?").get(row.id) as { n: number }).n;
    const exists = db.prepare("SELECT 1 FROM project_shares WHERE project_id = ? AND user_id = ?").get(row.id, target.id);
    if (!exists && count >= MAX_SHARES_PER_PROJECT) throw httpError(400, `A database can be shared with up to ${MAX_SHARES_PER_PROJECT} people.`);
    db.prepare(
      `INSERT INTO project_shares (project_id, user_id, permission, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, user_id) DO UPDATE SET permission = excluded.permission`,
    ).run(row.id, target.id, body.permission, new Date().toISOString());
    res.json(shareSettings(row.id));
  });

  router.delete("/:id/shares/:userId", (req, res) => {
    const { row } = load(req.params.id, req.user!.id, "owner");
    db.prepare("DELETE FROM project_shares WHERE project_id = ? AND user_id = ?").run(row.id, req.params.userId);
    res.json(shareSettings(row.id));
  });

  /** General access: nobody else, or anyone with an account who has the link (view or edit). */
  router.put("/:id/link-access", (req, res) => {
    const { row } = load(req.params.id, req.user!.id, "owner");
    const { linkAccess } = linkSchema.parse(req.body);
    db.prepare("UPDATE projects SET link_access = ? WHERE id = ?").run(linkAccess, row.id);
    res.json(shareSettings(row.id));
  });

  /** Public viewing: anyone on the internet with the link, without an account. */
  router.put("/:id/public-access", (req, res) => {
    const { row } = load(req.params.id, req.user!.id, "owner");
    const { publicView } = publicSchema.parse(req.body);
    db.prepare("UPDATE projects SET public_view = ? WHERE id = ?").run(publicView ? 1 : 0, row.id);
    res.json(shareSettings(row.id));
  });

  return router;
}

/**
 * Databases published for public viewing, readable without signing in. Only the database itself
 * is served: no export, copy, connections or linked data (those routes still need an account
 * with access). Unpublished and unknown ids both return 404.
 */
export function publicRouter(db: DB) {
  const router = Router();
  const loadPublic = (id: string) => {
    const row = db.prepare(`${SELECT_PROJECT} WHERE p.id = ? AND p.public_view = 1`).get(id) as ProjectListRow | undefined;
    if (!row) throw httpError(404, "This database isn't shared publicly.");
    return row;
  };
  router.get("/:id", (req, res) => {
    const row = loadPublic(req.params.id);
    const doc = JSON.parse(row.doc) as ProjectDoc;
    res.setHeader("Cache-Control", "no-store");
    // Editors' names aren't public.
    const { updatedByName: _, ...summary } = summarize(row, "view", doc);
    res.json({ project: { ...summary, doc, publicView: true } satisfies ProjectRecord });
  });
  router.get("/:id/revision", (req, res) => {
    const row = loadPublic(req.params.id);
    res.json({ revision: row.revision, updatedByName: null, updatedAt: row.updated_at });
  });
  return router;
}
