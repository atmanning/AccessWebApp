import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import type { DB } from "./db.js";
import { authRouter, loadUser } from "./auth.js";
import { projectsRouter, type ImportAccess } from "./projects.js";
import { connectionsRouter, type ConnectionsOptions } from "./connections.js";
import type { ProjectDoc } from "../../shared/model.js";

export interface AppOptions {
  db: DB;
  exportAccdb: (doc: ProjectDoc) => Promise<Buffer>;
  importAccess: ImportAccess;
  connections: ConnectionsOptions;
  secureCookies: boolean;
  /** Built web app to serve (web/dist). Omit in development; Vite serves it. */
  staticDir?: string;
  trustProxy?: boolean;
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
  app.use(express.json({ limit: "25mb" }));
  app.use(cookieParser());
  app.use(loadUser(opts.db));

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
  app.use("/api/auth", authRouter(opts.db, { secureCookies: opts.secureCookies }));
  app.use("/api/projects/:id/connections", connectionsRouter(opts.db, opts.connections));
  app.use("/api/projects", projectsRouter(opts.db, opts.exportAccdb, opts.importAccess));
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(opts.staticDir!, "index.html")));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.issues[0]?.message ?? "Invalid request" });
      return;
    }
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: (err as Error).message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Something went wrong" });
  });

  return app;
}
