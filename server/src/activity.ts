/**
 * The activity log behind the admin page. One middleware watches each API request finish and, for
 * the ones worth knowing about (sign-ins, opening and saving databases, sharing, public links,
 * errors…), writes a line: who, what, which database, and a short detail such as a size. It never
 * stores what's in anyone's tables.
 *
 * Busy actions (saves happen every few seconds while someone types) are folded together: a repeat
 * by the same person on the same database within a few minutes updates the last line's count.
 */
import type { NextFunction, Request, Response } from "express";
import type { ActivityAction } from "../../shared/activity.js";
import type { DB } from "./db.js";

/** Repeats within this long fold into one line. */
const FOLD_MS = 10 * 60_000;
const FOLDED = new Set<ActivityAction>(["open_db", "save", "public_report_view", "public_db_view", "upload_image", "run_sql", "record", "login_failed", "error"]);

export interface ActivityLine {
  action: ActivityAction;
  userId?: string | null;
  email?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  detail?: string | null;
  ip?: string | null;
}

export function createActivityLog(db: DB, opts: { retentionDays: number }) {
  const insert = db.prepare(
    `INSERT INTO activity (at, first_at, count, user_id, email, action, project_id, project_name, detail, ip)
     VALUES (@at, @first_at, @count, @user_id, @email, @action, @project_id, @project_name, @detail, @ip)`,
  );
  const lastLike = db.prepare(
    `SELECT id, first_at, count, at FROM activity
     WHERE action = @action AND user_id IS @user_id AND project_id IS @project_id AND (@ip IS NULL OR ip IS @ip)
     ORDER BY id DESC LIMIT 1`,
  );
  const remove = db.prepare("DELETE FROM activity WHERE id = ?");
  const purge = db.prepare("DELETE FROM activity WHERE at < ?");
  let lastPurge = 0;

  const write = db.transaction((line: ActivityLine) => {
    const now = new Date();
    const row = {
      at: now.toISOString(),
      first_at: now.toISOString(),
      count: 1,
      user_id: line.userId ?? null,
      email: line.email ?? null,
      action: line.action,
      project_id: line.projectId ?? null,
      project_name: line.projectName?.slice(0, 200) ?? null,
      detail: line.detail?.slice(0, 500) ?? null,
      ip: line.ip ?? null,
    };
    if (FOLDED.has(line.action)) {
      // Anonymous views fold by address; everything else by person and database.
      const prev = lastLike.get({ action: row.action, user_id: row.user_id, project_id: row.project_id, ip: row.user_id ? null : row.ip }) as
        | { id: number; first_at: string; count: number; at: string }
        | undefined;
      if (prev && now.getTime() - Date.parse(prev.at) < FOLD_MS) {
        // Moved to the end (a new id) so the newest lines are always last.
        remove.run(prev.id);
        row.first_at = prev.first_at;
        row.count = prev.count + 1;
      }
    }
    insert.run(row);
  });

  return {
    write(line: ActivityLine) {
      try {
        write(line);
        if (Date.now() - lastPurge > 3600_000) {
          lastPurge = Date.now();
          purge.run(new Date(Date.now() - opts.retentionDays * 86400_000).toISOString());
        }
      } catch (e) {
        // The log must never break the request it describes.
        console.error("activity log:", e);
      }
    },
  };
}

export type ActivityLog = ReturnType<typeof createActivityLog>;

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

type Match = { action: ActivityAction; detail?: string | null; project?: string | null; token?: string };

/** Which action a finished request was, if it's one worth logging. */
function classify(req: Request, status: number, path: string): Match | null {
  const m = req.method;
  const body = (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) ? req.body : {}) as Record<string, unknown>;
  const ok = status < 400;
  let p: RegExpExecArray | null;

  if (path === "/api/auth/register" && m === "POST") return ok ? { action: "register" } : null;
  if (path === "/api/auth/login" && m === "POST") return ok ? { action: "login" } : status === 401 || status === 403
        ? { action: "login_failed", detail: typeof body.email === "string" ? `${body.email.slice(0, 254)}${status === 403 ? " (suspended account)" : ""}` : null }
        : null;
  if (path === "/api/auth/logout" && m === "POST") return { action: "logout" };
  if (path === "/api/auth/accept-policy" && m === "POST") return ok ? { action: "accept_policy", detail: typeof body.version === "string" ? `version ${body.version.slice(0, 40)}` : null } : null;
  if (!ok) return null;

  if (path === "/api/projects" && m === "POST") return { action: "create_db", detail: typeof body.template === "string" && body.template !== "blank" ? `from the ${body.template} template` : null };
  if (path === "/api/projects/import-access" && m === "POST") return { action: "import_access", detail: Buffer.isBuffer(req.body) ? kb(req.body.length) : null };
  if (path === "/api/projects/convert-access" && m === "POST") return { action: "import_objects" };

  if ((p = /^\/api\/projects\/([\w-]{8,64})$/.exec(path))) {
    if (m === "GET") return { action: "open_db", project: p[1] };
    if (m === "PUT") {
      if (body.doc && typeof body.doc === "object") {
        const doc = body.doc as { tables?: { rows?: unknown[] }[] };
        const tables = Array.isArray(doc.tables) ? doc.tables : [];
        const records = tables.reduce((n, t) => n + (Array.isArray(t.rows) ? t.rows.length : 0), 0);
        const size = Number(req.get("content-length") ?? 0);
        return { action: "save", project: p[1], detail: `${tables.length} tables, ${records} records${size ? `, ${kb(size)}` : ""}` };
      }
      if (body.name) return { action: "rename_db", project: p[1], detail: `to ${String(body.name).slice(0, 100)}` };
      return null;
    }
    if (m === "DELETE") return { action: "delete_db", project: p[1] };
  }
  if ((p = /^\/api\/projects\/([\w-]{8,64})\/(copy|export\.accdb|shares|shares\/[\w-]+|link-access|public-access)$/.exec(path))) {
    const [, id, what] = p;
    if (what === "copy" && m === "POST") return { action: "copy_db", project: id, detail: typeof body.name === "string" ? `as ${body.name.slice(0, 100)}` : null };
    if (what === "export.accdb" && m === "GET") return { action: "export", project: id };
    if (what === "shares" && m === "PUT") return { action: "share", project: id, detail: `with ${String(body.email ?? "")} (${body.permission === "edit" ? "can edit" : "can view"})` };
    if (what.startsWith("shares/") && m === "DELETE") return { action: "unshare", project: id };
    if (what === "link-access" && m === "PUT") return { action: "link_access", project: id, detail: body.linkAccess === "none" ? "turned off" : `anyone with the link can ${body.linkAccess}` };
    if (what === "public-access" && m === "PUT") return { action: "public_view", project: id, detail: body.publicView ? "turned on" : "turned off" };
  }
  if ((p = /^\/api\/projects\/([\w-]{8,64})\/public-reports\/[\w-]+$/.exec(path))) {
    if (m === "PUT") return { action: "publish_report", project: p[1] };
    if (m === "DELETE") return { action: "unpublish_report", project: p[1] };
  }
  if ((p = /^\/api\/projects\/([\w-]{8,64})\/images$/.exec(path)) && m === "POST") return { action: "upload_image", project: p[1] };
  if ((p = /^\/api\/projects\/([\w-]{8,64})\/connections(\/[\w-]+)?(\/sql|\/import)?$/.exec(path)) && m === "POST") {
    if (!p[2] && !p[3]) return { action: "add_connection", project: p[1] };
    if (p[3] === "/sql") return { action: "run_sql", project: p[1] };
    if (p[3] === "/import") return { action: "import_mysql", project: p[1] };
  }
  if ((p = /^\/api\/public-reports\/([A-Za-z0-9_-]{16,64})$/.exec(path)) && m === "GET") return { action: "public_report_view", token: p[1] };
  if ((p = /^\/api\/public-reports\/([A-Za-z0-9_-]{16,64})\/record$/.exec(path)) && m === "POST") return { action: "record", token: p[1] };
  if ((p = /^\/api\/public\/([\w-]{8,64})$/.exec(path)) && m === "GET") return { action: "public_db_view", project: p[1] };
  return null;
}

/**
 * Watches API requests and logs the ones worth knowing about. Put it after the body parsers and
 * loadUser. Routes that sign someone in leave their id in res.locals.activityUser.
 */
export function activityMiddleware(db: DB, log: ActivityLog) {
  const projectName = db.prepare("SELECT name FROM projects WHERE id = ?");
  const reportProject = db.prepare("SELECT r.project_id AS id, p.name FROM public_reports r JOIN projects p ON p.id = r.project_id WHERE r.token = ?");
  const userById = db.prepare("SELECT id, email FROM users WHERE id = ?");
  const seen = db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?");
  const lastSeen = new Map<string, number>();

  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.originalUrl.startsWith("/api/")) return next();
    const path = req.originalUrl.split("?")[0];
    if (path === "/api/health" || path === "/api/version") return next();

    // "Last active", at most once every 5 minutes per person.
    if (req.user) {
      const t = lastSeen.get(req.user.id) ?? 0;
      if (Date.now() - t > 5 * 60_000) {
        lastSeen.set(req.user.id, Date.now());
        if (lastSeen.size > 50_000) lastSeen.clear();
        try {
          seen.run(new Date().toISOString(), req.user.id);
        } catch {
          /* never block a request on this */
        }
      }
    }

    // The database's name before the request runs (it's gone after a delete).
    const pid = /^\/api\/(?:projects|public)\/([\w-]{8,64})(?:\/|$)/.exec(path)?.[1];
    const nameBefore = pid ? ((projectName.get(pid) as { name: string } | undefined)?.name ?? null) : null;
    const who = req.user;

    res.on("finish", () => {
      const status = res.statusCode;
      let match = classify(req, status, path);
      if (!match && status >= 500) match = { action: "error", detail: `${req.method} ${path.replace(/[\w-]{20,}/g, "…")}: ${String(res.locals.errorMessage ?? `status ${status}`).slice(0, 300)}` };
      if (!match) return;
      // Someone who just signed in or up.
      const signedIn = res.locals.activityUser ? (userById.get(res.locals.activityUser) as { id: string; email: string } | undefined) : undefined;
      const user = signedIn ?? (who ? { id: who.id, email: who.email } : undefined);
      let projectId = match.project ?? pid ?? null;
      let name = nameBefore;
      if (match.token) {
        const r = reportProject.get(match.token) as { id: string; name: string } | undefined;
        projectId = r?.id ?? null;
        name = r?.name ?? null;
      }
      if (projectId && !name) name = (projectName.get(projectId) as { name: string } | undefined)?.name ?? null;
      // "Deleted" by someone who doesn't own it only takes it off their list.
      const action = match.action === "delete_db" && (res.locals.removedOnly as boolean) ? "remove_shared" : match.action;
      // A new database: the one just made.
      const created = res.locals.createdProject as { id: string; name: string } | undefined;
      if (created && (match.action === "create_db" || match.action === "import_access")) {
        projectId = created.id;
        name = created.name;
      }
      log.write({
        action,
        userId: user?.id ?? null,
        email: user?.email ?? null,
        projectId,
        projectName: name,
        detail: match.detail ?? null,
        ip: req.ip ?? null,
      });
    });
    next();
  };
}
