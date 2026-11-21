/**
 * Which features each person can use, and the gate that refuses advanced ones to people without
 * them. A feature belongs to a database's owner: if the owner has Sharing, their editors can share.
 *
 * When "Require a plan" is off (the default) everyone has everything. When it's on, the advanced
 * features need one of: an Advanced subscription (Stripe), the admin enabling them for that person,
 * or being an admin. Things already set up keep working (existing shares, public links, linked
 * MySQL tables); only setting up new ones is refused.
 */
import type { NextFunction, Request, Response } from "express";
import { AI_DEFAULTS, FEATURE_IDS, PLAN_INCLUDES, type AiPlanSettings, type FeatureId, type PlanStatus } from "../../shared/plans.js";
import type { DB } from "./db.js";

export function settingsStore(db: DB) {
  const get = db.prepare("SELECT value FROM settings WHERE key = ?");
  const set = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const del = db.prepare("DELETE FROM settings WHERE key = ?");
  return {
    get: (key: string): string | null => (get.get(key) as { value: string } | undefined)?.value ?? null,
    set: (key: string, value: string | null) => void (value === null ? del.run(key) : set.run(key, value)),
  };
}

const featureList = (json: string | null): FeatureId[] => {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? FEATURE_IDS.filter((f) => v.includes(f)) : [];
  } catch {
    return [];
  }
};

export interface PlanUserRow {
  id: string;
  email: string;
  features: string | null;
  plan_status: string | null;
}

export function createPlans(db: DB, isAdmin: (u: { id: string; email: string }) => boolean, aiDailyDefault = AI_DEFAULTS.daily, aiConfigured = false) {
  const settings = settingsStore(db);
  const userRow = db.prepare("SELECT id, email, features, plan_status FROM users WHERE id = ?");

  const gated = () => settings.get("plans.gated") === "on";
  // The AI assistant costs money per request, so it's always part of the plan (after the free
  // requests everyone gets), whether or not "Require a plan" is on.
  const advanced = (): FeatureId[] => {
    const saved = settings.get("plans.advanced");
    const list = saved === null ? [...FEATURE_IDS] : featureList(saved);
    return FEATURE_IDS.filter((f) => f === "ai" || list.includes(f));
  };

  /** What a person can use, from their row (the AI assistant: unlimited use, beyond the free requests). */
  const featuresOf = (u: PlanUserRow): FeatureId[] => {
    const granted = new Set(featureList(u.features));
    if (isAdmin(u) || PLAN_INCLUDES.has(u.plan_status ?? "")) return [...FEATURE_IDS];
    if (!gated()) return FEATURE_IDS.filter((f) => f !== "ai" || granted.has(f));
    const adv = new Set(advanced());
    return FEATURE_IDS.filter((f) => !adv.has(f) || granted.has(f));
  };

  /** The AI assistant's allowances (Site admin → Plans). */
  const aiSettings = (): AiPlanSettings => {
    const n = (key: string, dflt: number) => {
      const v = Number(settings.get(key));
      return settings.get(key) !== null && Number.isFinite(v) && v >= 0 ? Math.floor(v) : dflt;
    };
    return {
      free: n("ai.free", AI_DEFAULTS.free),
      period: settings.get("ai.freePeriod") === "month" ? "month" : "once",
      daily: n("ai.daily", aiDailyDefault),
    };
  };

  return {
    settings,
    gated,
    advanced,
    aiSettings,
    /** What the plan adds right now: the advanced features when plans are required, and the AI assistant when the site has it. */
    sold: (): FeatureId[] => (gated() ? advanced() : ["ai" as FeatureId]).filter((f) => f !== "ai" || aiConfigured),
    featureList,
    featuresOf,
    has(userId: string, f: FeatureId) {
      const u = userRow.get(userId) as PlanUserRow | undefined;
      return !!u && featuresOf(u).includes(f);
    },
    planStatus: (s: string | null) => (s as PlanStatus | null) ?? null,
  };
}

export type Plans = ReturnType<typeof createPlans>;

/** The feature a request would use, and whose plan decides it ("owner" of the database or "self"). */
function featureFor(req: Request, path: string): { feature: FeatureId; project?: string } | null {
  const m = req.method;
  const body = (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) ? req.body : {}) as Record<string, unknown>;
  let p: RegExpExecArray | null;
  if (m === "POST" && (path === "/api/projects/import-access" || path === "/api/projects/convert-access")) return { feature: "accdb" };
  if ((p = /^\/api\/projects\/([\w-]{8,64})\/(.+)$/.exec(path))) {
    const [, id, rest] = p;
    if (rest === "export.accdb" && m === "GET") return { feature: "accdb", project: id };
    if (rest === "shares" && m === "PUT") return { feature: "sharing", project: id };
    if (rest === "link-access" && m === "PUT" && body.linkAccess !== "none") return { feature: "sharing", project: id };
    if (rest === "public-access" && m === "PUT" && body.publicView === true) return { feature: "public", project: id };
    if (/^public-reports\/[\w-]+$/.test(rest) && m === "PUT") return { feature: "public", project: id };
    if (/^connections(\/test|\/[\w-]+(\/sql|\/import)?)?$/.test(rest) && (m === "POST" || m === "PUT")) return { feature: "mysql", project: id };
  }
  return null;
}

const MESSAGES: Record<FeatureId, string> = {
  sharing: "Sharing",
  public: "Public links",
  mysql: "MySQL connections",
  accdb: "Importing and downloading Access files",
  ai: "The AI assistant",
};

/** Refuses advanced features to people (or databases' owners) without them: 402, code "upgrade". */
export function planGate(db: DB, plans: Plans) {
  const project = db.prepare("SELECT user_id, link_access FROM projects WHERE id = ?");
  const shared = db.prepare("SELECT 1 FROM project_shares WHERE project_id = ? AND user_id = ?");
  const reportExists = db.prepare("SELECT 1 FROM public_reports WHERE project_id = ? AND report_id = ?");

  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !plans.gated() || !req.originalUrl.startsWith("/api/projects")) return next();
    const path = req.originalUrl.split("?")[0];
    const need = featureFor(req, path);
    if (!need) return next();
    let ownerId = req.user.id;
    if (need.project) {
      const row = project.get(need.project) as { user_id: string; link_access: string } | undefined;
      if (!row) return next();
      // People who can't see the database get the route's own "doesn't exist" answer.
      if (row.user_id !== req.user.id && !shared.get(need.project, req.user.id) && row.link_access === "none") return next();
      ownerId = row.user_id;
      // Refreshing a report that's already public is fine; making a new one public isn't.
      const rid = /\/public-reports\/([\w-]+)$/.exec(path)?.[1];
      if (rid && reportExists.get(need.project, rid)) return next();
    }
    if (plans.has(ownerId, need.feature)) return next();
    const yours = ownerId === req.user.id;
    res.status(402).json({
      error: yours
        ? `${MESSAGES[need.feature]} is part of the Advanced plan. Upgrade to use it.`
        : `${MESSAGES[need.feature]} isn't available for this database: its owner's plan doesn't include it.`,
      code: "upgrade",
      feature: need.feature,
      yours,
    });
  };
}
