/**
 * The site admin page's API, under /api/admin: registered accounts, how much they use the site, and
 * the activity log. Database names and sizes are shown; what's in the tables never is.
 *
 * Admins are the emails in ADMIN_EMAILS (comma-separated). If that isn't set, the first account ever
 * registered is the admin, so a new install works without any setup.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { ACTIVITY_ACTIONS, type ActivityEntry, type AdminOverview, type AdminUserDetail, type AdminUserRow } from "../../shared/activity.js";
import type { DB } from "./db.js";
import type { ActivityLog } from "./activity.js";
import { FEATURE_IDS, type AdminPlans, type FeatureId } from "../../shared/plans.js";
import type { Plans } from "./plans.js";
import type { BillingOptions } from "./billing.js";
import { httpError } from "./projects.js";

export function adminCheck(db: DB, adminEmails: string[]) {
  const emails = new Set(adminEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const first = db.prepare("SELECT id FROM users ORDER BY created_at, rowid LIMIT 1");
  return (user: { id: string; email: string } | undefined): boolean => {
    if (!user) return false;
    if (emails.size) return emails.has(user.email.toLowerCase());
    return (first.get() as { id: string } | undefined)?.id === user.id;
  };
}

interface ActivityRow {
  id: number;
  at: string;
  first_at: string;
  count: number;
  user_id: string | null;
  email: string | null;
  name: string | null;
  action: string;
  project_id: string | null;
  project_name: string | null;
  detail: string | null;
  ip: string | null;
}

const entry = (r: ActivityRow): ActivityEntry => ({
  id: r.id,
  at: r.at,
  firstAt: r.first_at,
  count: r.count,
  userId: r.user_id,
  email: r.email,
  name: r.name,
  action: r.action as ActivityEntry["action"],
  projectId: r.project_id,
  projectName: r.project_name,
  detail: r.detail,
  ip: r.ip,
});

const activityQuery = z.object({
  user: z.string().max(64).optional(),
  action: z.enum(Object.keys(ACTIVITY_ACTIONS) as [string, ...string[]]).optional(),
  q: z.string().max(200).optional(),
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Quote everything; a leading = + - @ could run as a formula in a spreadsheet.
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

export function adminRouter(
  db: DB,
  opts: { isAdmin: (u: Request["user"]) => boolean; logDays: number; log?: ActivityLog; plans?: Plans; billing?: BillingOptions; priceLabel?: () => Promise<string | null> },
) {
  const router = Router();
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return void res.status(401).json({ error: "Please sign in." });
    // Not an admin: the same answer as a page that doesn't exist.
    if (!opts.isAdmin(req.user)) return void res.status(404).json({ error: "That isn't something this server can do." });
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number | null }).n ?? 0;
  const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();

  router.get("/overview", (_req, res) => {
    const since = ago(29).slice(0, 10);
    const signups = new Map(
      (db.prepare("SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY d").all(since) as { d: string; n: number }[]).map((r) => [r.d, r.n]),
    );
    const active = new Map(
      (
        db
          .prepare("SELECT substr(at, 1, 10) AS d, COUNT(DISTINCT user_id) AS n FROM activity WHERE at >= ? AND user_id IS NOT NULL GROUP BY d")
          .all(since) as { d: string; n: number }[]
      ).map((r) => [r.d, r.n]),
    );
    const days: AdminOverview["days"] = [];
    for (let i = 29; i >= 0; i--) {
      const day = ago(i).slice(0, 10);
      days.push({ day, signups: signups.get(day) ?? 0, active: active.get(day) ?? 0 });
    }
    const overview: AdminOverview = {
      users: count("SELECT COUNT(*) AS n FROM users"),
      newUsers7: count("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?", ago(7)),
      newUsers30: count("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?", ago(30)),
      active1: count("SELECT COUNT(*) AS n FROM users WHERE last_seen_at >= ?", ago(1)),
      active7: count("SELECT COUNT(*) AS n FROM users WHERE last_seen_at >= ?", ago(7)),
      active30: count("SELECT COUNT(*) AS n FROM users WHERE last_seen_at >= ?", ago(30)),
      databases: count("SELECT COUNT(*) AS n FROM projects"),
      storageBytes: count("SELECT SUM(length(doc)) AS n FROM projects") + count("SELECT SUM(size) AS n FROM images"),
      publicReports: count("SELECT COUNT(*) AS n FROM public_reports"),
      shares: count("SELECT COUNT(*) AS n FROM project_shares"),
      errors24: count("SELECT SUM(count) AS n FROM activity WHERE action = 'error' AND at >= ?", ago(1)),
      failedLogins24: count("SELECT SUM(count) AS n FROM activity WHERE action = 'login_failed' AND at >= ?", ago(1)),
      days,
      logDays: opts.logDays,
    };
    res.json(overview);
  });

  const USER_SELECT = `
    SELECT u.id, u.email, u.name, u.created_at AS createdAt, u.last_seen_at AS lastSeenAt,
      u.suspended_at AS suspendedAt, u.suspended_reason AS suspendedReason,
      u.policy_version AS policyVersion, u.policy_accepted_at AS policyAcceptedAt,
      (SELECT COUNT(*) FROM projects p WHERE p.user_id = u.id) AS databases,
      (SELECT COUNT(*) FROM project_shares s WHERE s.user_id = u.id) AS sharedWithThem,
      COALESCE((SELECT SUM(length(p.doc)) FROM projects p WHERE p.user_id = u.id), 0)
        + COALESCE((SELECT SUM(i.size) FROM images i JOIN projects p ON p.id = i.project_id WHERE p.user_id = u.id), 0) AS storageBytes,
      COALESCE((SELECT SUM(a.count) FROM activity a WHERE a.user_id = u.id AND a.at >= @since), 0) AS actions30,
      COALESCE((SELECT SUM(a.count) FROM activity a WHERE a.user_id = u.id AND a.action = 'error' AND a.at >= @since), 0) AS errors30,
      (SELECT MAX(a.at) FROM activity a WHERE a.user_id = u.id AND a.action = 'error' AND a.at >= @since) AS lastErrorAt
    FROM users u`;

  const userRow = (r: Omit<AdminUserRow, "admin">): AdminUserRow => ({ ...r, admin: opts.isAdmin(r) });

  router.get("/users", (req, res) => {
    const q = z.string().max(200).optional().parse(req.query.q)?.trim();
    const rows = db
      .prepare(`${USER_SELECT} ${q ? "WHERE u.email LIKE @q ESCAPE '\\' OR u.name LIKE @q ESCAPE '\\'" : ""} ORDER BY COALESCE(u.last_seen_at, u.created_at) DESC LIMIT 2000`)
      .all({ since: ago(30), ...(q ? { q: `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` } : {}) }) as Omit<AdminUserRow, "admin">[];
    res.json({ users: rows.map(userRow) });
  });

  router.get("/users/:id", (req, res) => {
    const r = db.prepare(`${USER_SELECT} WHERE u.id = @id`).get({ since: ago(30), id: req.params.id }) as Omit<AdminUserRow, "admin"> | undefined;
    if (!r) throw httpError(404, "That account doesn't exist any more.");
    const dbs = db
      .prepare(
        `SELECT p.id, p.name, p.created_at AS createdAt, p.updated_at AS updatedAt, p.link_access AS linkAccess, p.public_view AS publicView,
           json_array_length(p.doc, '$.tables') AS tables,
           COALESCE((SELECT SUM(json_array_length(t.value, '$.rows')) FROM json_each(p.doc, '$.tables') t), 0) AS records,
           length(p.doc) + COALESCE((SELECT SUM(size) FROM images i WHERE i.project_id = p.id), 0) AS sizeBytes,
           (SELECT COUNT(*) FROM project_shares s WHERE s.project_id = p.id) AS sharedWith,
           (SELECT COUNT(*) FROM public_reports r WHERE r.project_id = p.id) AS publicReports
         FROM projects p WHERE p.user_id = ? ORDER BY p.updated_at DESC`,
      )
      .all(r.id) as (AdminUserDetail["dbs"][number] & { publicView: number | boolean })[];
    const activity = (
      db.prepare("SELECT a.*, u.name FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.user_id = ? ORDER BY a.id DESC LIMIT 200").all(r.id) as ActivityRow[]
    ).map(entry);
    const detail: AdminUserDetail = {
      ...userRow(r),
      signedInDevices: count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?", r.id, new Date().toISOString()),
      dbs: dbs.map((d) => ({ ...d, publicView: !!d.publicView })),
      activity,
    };
    res.json(detail);
  });

  // Suspending an account (a ban for misuse): it can't sign in, it's signed out everywhere, and its
  // databases close to the people it shared them with and to public links. Nothing is deleted, so
  // reinstating puts everything back.
  router.post("/users/:id/suspend", (req, res) => {
    const reason = z.object({ reason: z.string().trim().min(1, "Please say why, for the record (for example, what the misuse was).").max(500) }).parse(req.body).reason;
    const u = db.prepare("SELECT id, email, name, suspended_at FROM users WHERE id = ?").get(req.params.id) as { id: string; email: string; name: string; suspended_at: string | null } | undefined;
    if (!u) throw httpError(404, "That account doesn't exist any more.");
    if (u.id === req.user!.id || opts.isAdmin(u)) throw httpError(400, "Admin accounts can't be suspended here. Remove the email from ADMIN_EMAILS first.");
    db.transaction(() => {
      db.prepare("UPDATE users SET suspended_at = COALESCE(suspended_at, ?), suspended_reason = ? WHERE id = ?").run(new Date().toISOString(), reason, u.id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
    })();
    opts.log?.write({ action: "suspend", userId: u.id, email: u.email, detail: `${reason} (by ${req.user!.email})`, ip: req.ip ?? null });
    res.json({ ok: true });
  });

  router.post("/users/:id/unsuspend", (req, res) => {
    const u = db.prepare("SELECT id, email FROM users WHERE id = ?").get(req.params.id) as { id: string; email: string } | undefined;
    if (!u) throw httpError(404, "That account doesn't exist any more.");
    db.prepare("UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?").run(u.id);
    opts.log?.write({ action: "unsuspend", userId: u.id, email: u.email, detail: `by ${req.user!.email}`, ip: req.ip ?? null });
    res.json({ ok: true });
  });

  // ---- Plans: which features are advanced, and who has them ----------------------------------

  const featureSchema = z.enum(FEATURE_IDS as [FeatureId, ...FeatureId[]]);

  router.get("/plans", async (req, res) => {
    const plans = opts.plans!;
    const rows = db.prepare("SELECT id, email, name, features, plan_status FROM users ORDER BY lower(COALESCE(NULLIF(name, ''), email))").all() as {
      id: string;
      email: string;
      name: string;
      features: string | null;
      plan_status: string | null;
    }[];
    const out: AdminPlans = {
      gated: plans.gated(),
      advanced: plans.advanced(),
      ai: plans.aiSettings(),
      users: rows.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        planStatus: plans.planStatus(u.plan_status),
        granted: plans.featureList(u.features),
        features: plans.featuresOf(u),
        admin: opts.isAdmin(u),
      })),
      stripe: {
        configured: !!opts.billing?.stripe,
        mode: opts.billing?.stripe ? (opts.billing.mode ?? "test") : null,
        priceId: opts.billing?.priceId ?? plans.settings.get("stripe.price"),
        price: (await opts.priceLabel?.()) ?? null,
        webhookSecret: !!opts.billing?.webhookSecret,
        lastWebhookAt: plans.settings.get("stripe.last_webhook"),
        webhookUrl: `${req.protocol}://${req.get("host")}/api/billing/webhook`,
      },
    };
    res.json(out);
  });

  router.put("/plans/settings", (req, res) => {
    const plans = opts.plans!;
    const body = z
      .object({
        gated: z.boolean(),
        advanced: z.array(featureSchema).max(FEATURE_IDS.length),
        ai: z.object({ free: z.number().int().min(0).max(100_000), period: z.enum(["once", "month"]), daily: z.number().int().min(1).max(100_000) }).optional(),
      })
      .parse(req.body);
    const was = { gated: plans.gated(), advanced: plans.advanced(), ai: plans.aiSettings() };
    plans.settings.set("plans.gated", body.gated ? "on" : "off");
    plans.settings.set("plans.advanced", JSON.stringify([...new Set(body.advanced)]));
    const parts: string[] = [];
    if (body.ai) {
      plans.settings.set("ai.free", String(body.ai.free));
      plans.settings.set("ai.freePeriod", body.ai.period);
      plans.settings.set("ai.daily", String(body.ai.daily));
      if (JSON.stringify(was.ai) !== JSON.stringify(body.ai)) parts.push(`AI: ${body.ai.free} free request(s) ${body.ai.period === "month" ? "a month" : "to try it"}, ${body.ai.daily} a day with the plan`);
    }
    if (was.gated !== body.gated) parts.push(`Require a plan: ${body.gated ? "on" : "off"}`);
    if (was.advanced.join() !== plans.advanced().join()) parts.push(`advanced features: ${body.advanced.join(", ") || "none"}`);
    if (parts.length) opts.log?.write({ action: "plans_settings", userId: req.user!.id, email: req.user!.email, detail: parts.join("; "), ip: req.ip ?? null });
    res.json({ ok: true });
  });

  router.post("/plans/grant", (req, res) => {
    const body = z
      .object({ userIds: z.array(z.string().max(64)).min(1, "Choose at least one person.").max(5000), features: z.array(featureSchema).min(1, "Choose at least one feature."), enable: z.boolean() })
      .parse(req.body);
    const get = db.prepare("SELECT id, email, features FROM users WHERE id = ?");
    const set = db.prepare("UPDATE users SET features = ? WHERE id = ?");
    let changed = 0;
    db.transaction(() => {
      for (const id of body.userIds) {
        const u = get.get(id) as { id: string; email: string; features: string | null } | undefined;
        if (!u) continue;
        const have = new Set(opts.plans!.featureList(u.features));
        for (const f of body.features) body.enable ? have.add(f) : have.delete(f);
        const next = FEATURE_IDS.filter((f) => have.has(f));
        if (next.join() === opts.plans!.featureList(u.features).join()) continue;
        set.run(next.length ? JSON.stringify(next) : null, u.id);
        changed++;
        opts.log?.write({
          action: "features_change",
          userId: u.id,
          email: u.email,
          detail: `${body.enable ? "enabled" : "disabled"} ${body.features.join(", ")} (by ${req.user!.email})`,
          ip: req.ip ?? null,
        });
      }
    })();
    res.json({ ok: true, changed });
  });

  const findActivity = (query: z.infer<typeof activityQuery>) => {
    const where: string[] = [];
    const args: Record<string, unknown> = { limit: query.limit };
    if (query.user) (where.push("a.user_id = @user"), (args.user = query.user));
    if (query.action) (where.push("a.action = @action"), (args.action = query.action));
    if (query.before) (where.push("a.id < @before"), (args.before = query.before));
    if (query.q?.trim()) {
      where.push("(a.email LIKE @q ESCAPE '\\' OR u.name LIKE @q ESCAPE '\\' OR a.project_name LIKE @q ESCAPE '\\' OR a.detail LIKE @q ESCAPE '\\' OR a.ip LIKE @q ESCAPE '\\')");
      args.q = `%${query.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    }
    return (
      db
        .prepare(`SELECT a.*, u.name FROM activity a LEFT JOIN users u ON u.id = a.user_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.id DESC LIMIT @limit`)
        .all(args) as ActivityRow[]
    ).map(entry);
  };

  router.get("/activity", (req, res) => {
    const query = activityQuery.parse(req.query);
    const entries = findActivity(query);
    res.json({ entries, more: entries.length === query.limit ? entries[entries.length - 1].id : null });
  });

  router.get("/activity.csv", (req, res) => {
    const entries = findActivity({ ...activityQuery.parse({ ...req.query, limit: 1 }), limit: 50_000 });
    const lines = [
      ["Time (UTC)", "First time (UTC)", "Times", "Name", "Email", "Action", "Database", "Detail", "IP address"].map(csvCell).join(","),
      ...entries.map((e) =>
        [e.at, e.count > 1 ? e.firstAt : "", e.count, e.name, e.email, ACTIVITY_ACTIONS[e.action] ?? e.action, e.projectName, e.detail, e.ip].map(csvCell).join(","),
      ),
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="activity-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(`﻿${lines.join("\r\n")}\r\n`);
  });

  return router;
}
