import express, { type NextFunction, type Request, type Response } from "express";
import { publicReportsReadRouter, publicReportsRouter } from "./publicReports.js";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import type { DB } from "./db.js";
import { authRouter, loadUser } from "./auth.js";
import { activityMiddleware, createActivityLog } from "./activity.js";
import { adminCheck, adminRouter } from "./admin.js";
import { createPlans, planGate } from "./plans.js";
import { createBilling, type BillingOptions } from "./billing.js";
import { aiRouter, type AiOptions } from "./ai.js";
import { projectsRouter, publicRouter, type ImportAccess } from "./projects.js";
import { connectionsRouter, type ConnectionsOptions } from "./connections.js";
import { imagesRouter, publicImagesRouter, type ImageOptions } from "./images.js";
import type { ProjectDoc, VersionInfo } from "../../shared/model.js";

export interface AppOptions {
  db: DB;
  exportAccdb: (doc: ProjectDoc) => Promise<Buffer>;
  importAccess: ImportAccess;
  connections: ConnectionsOptions;
  images?: ImageOptions;
  secureCookies: boolean;
  /** Built web app to serve (web/dist). Omit in development; Vite serves it. */
  staticDir?: string;
  trustProxy?: boolean;
  /** Which build is running (GET /api/version). */
  version?: VersionInfo;
  /** Who can open the admin page (ADMIN_EMAILS); empty = the first account registered. */
  adminEmails?: string[];
  /** How long the activity log keeps lines (default 90 days). */
  logDays?: number;
  /** Who to contact about the Usage Policy or misuse (CONTACT_EMAIL), shown in the policy. */
  contact?: string | null;
  /** Stripe, for the Advanced plan (STRIPE_SECRET_KEY…); without it, only the admin can turn features on. */
  billing?: BillingOptions;
  /** The AI assistant (ANTHROPIC_API_KEY…); off without a key. */
  ai?: AiOptions;
}

export function createApp(opts: AppOptions) {
  const app = express();
  if (opts.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // sql.js runs SQLite as WebAssembly in the browser.
          "script-src": ["'self'", "'wasm-unsafe-eval'"],
          "img-src": ["'self'", "data:"],
          // Only force HTTPS sub-requests when the site is actually served over HTTPS.
          "upgrade-insecure-requests": opts.secureCookies ? [] : null,
        },
      },
    }),
  );
  const logDays = opts.logDays ?? 90;
  const activityLog = createActivityLog(opts.db, { retentionDays: logDays });
  const isAdmin = adminCheck(opts.db, opts.adminEmails ?? []);
  const plans = createPlans(opts.db, isAdmin, opts.ai?.dailyLimit, !!opts.ai?.apiKey);
  const billingOpts: BillingOptions = opts.billing ?? { stripe: null, webhookSecret: null, priceId: null };
  const billing = createBilling(opts.db, plans, { ...billingOpts, log: activityLog, isAdmin });
  // Stripe signs the raw body, so its webhook comes before the JSON parser.
  app.use("/api/billing/webhook", billing.webhook);

  app.use(express.json({ limit: "25mb" }));
  app.use(cookieParser());
  app.use(loadUser(opts.db));
  app.use(activityMiddleware(opts.db, activityLog));

  // CSRF defence: state-changing API calls must be JSON or carry X-Requested-With. A cross-site
  // HTML form can do neither, and fetch() from another origin would need a CORS preflight we never grant.
  // Session cookies are also SameSite=Lax.
  app.use("/api", (req, res, next) => {
    const mutating = ["POST", "PUT", "DELETE", "PATCH"].includes(req.method);
    if (mutating && !req.is("application/json") && !req.get("X-Requested-With")) {
      res.status(415).json({ error: "Requests must be JSON." });
      return;
    }
    next();
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  const version: VersionInfo = opts.version ?? { commit: null, builtAt: null, startedAt: new Date().toISOString() };
  app.get("/api/version", (_req, res) => res.json(version));
  app.use("/api/auth", authRouter(opts.db, { secureCookies: opts.secureCookies, isAdmin, contact: opts.contact ?? null }));
  app.use("/api/admin", adminRouter(opts.db, { isAdmin, logDays, log: activityLog, plans, billing: billingOpts, priceLabel: billing.price }));
  app.use("/api/billing", billing.router);
  // Advanced features (sharing, public links, MySQL, Access files) for people whose plan has them.
  app.use("/api/ai", aiRouter(opts.db, plans, opts.ai ?? { apiKey: null, model: "", dailyLimit: 0 }));
  app.use(planGate(opts.db, plans));
  app.use("/api/projects/:id/connections", connectionsRouter(opts.db, opts.connections));
  app.use("/api/projects/:id/images", imagesRouter(opts.db, opts.images ?? { maxBytesPerProject: 200 * 1024 * 1024 }));
  app.use("/api/public/:id/images", publicImagesRouter(opts.db));
  app.use("/api/projects/:id/public-reports", publicReportsRouter(opts.db));
  app.use("/api/public-reports", publicReportsReadRouter(opts.db));
  app.use("/api/projects", projectsRouter(opts.db, opts.exportAccdb, opts.importAccess));
  app.use("/api/public", publicRouter(opts.db));
  app.use("/api", (_req, res) => res.status(404).json({ error: "That isn't something this server can do. Try reloading the page." }));

  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(opts.staticDir!, "index.html")));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // For the admin page's activity log (server errors only; the person sees a plain message).
    res.locals.errorMessage = err instanceof Error ? err.message : String(err);
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.issues[0]?.message ?? "Something in that request wasn't right. Please try again." });
      return;
    }
    const status = (err as { status?: number }).status;
    // Errors from reading the request body (express), in plain words.
    const type = (err as { type?: string }).type;
    if (type === "entity.too.large") {
      res.status(413).json({ error: "That's too much to save at once (over 25 MB). Large pictures or imports are the usual cause; try removing some." });
      return;
    }
    if (type === "entity.parse.failed") {
      res.status(400).json({ error: "That request couldn't be read. Please reload the page and try again." });
      return;
    }
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: (err as Error).message });
      return;
    }
    // Stripe answered with an error (a bad key, a deleted price…): say so plainly.
    if ((err as { type?: string }).type?.startsWith?.("Stripe")) {
      res.status(502).json({ error: `Stripe said: ${(err as Error).message}` });
      return;
    }
    console.error(err);
    // The details go to the server log; people get a plain message.
    res.status(500).json({ error: "Something went wrong on the server. Please try again in a moment; your work up to the last save is safe." });
  });

  return app;
}
