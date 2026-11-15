import { Router, type NextFunction, type Request, type Response } from "express";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import type { DB } from "./db.js";
import type { UserInfo } from "../../shared/model.js";
import { POLICY_VERSION } from "../../shared/policy.js";

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;
export const SESSION_COOKIE = "sid";
const SESSION_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(key, expected);
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

declare module "express-serve-static-core" {
  interface Request {
    user?: UserInfo;
  }
}

/** Very small fixed-window limiter for login/registration, keyed by IP. */
function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip ?? "unknown";
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return next();
    }
    if (++entry.count > max) {
      res.status(429).json({ error: "Too many attempts. Please wait a few minutes and try again." });
      return;
    }
    next();
  };
}

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(254),
  name: z.string().trim().min(1, "Enter your name").max(100),
  password: z.string().min(8, "Passwords must be at least 8 characters").max(200),
  acceptPolicy: z.literal(true, { error: "Please read the Usage Policy and tick the box to agree to it." }),
});
const loginSchema = z.object({ email: z.string().trim().toLowerCase().max(254), password: z.string().max(200) });

/** The message a suspended account sees when it tries to sign in. */
export function suspendedMessage(contact: string | null) {
  return `This account has been suspended for breaking the Usage Policy.${contact ? ` If you think this is a mistake, contact ${contact}.` : ""}`;
}

export function authRouter(db: DB, opts: { secureCookies: boolean; isAdmin?: (u: UserInfo) => boolean; contact?: string | null }) {
  const router = Router();
  const limiter = rateLimit(20, 15 * 60 * 1000);
  /** Admins see a link to the site admin page. */
  const withAdmin = (u: UserInfo): UserInfo => (opts.isAdmin?.(u) ? { ...u, admin: true } : u);

  function startSession(res: Response, userId: string) {
    const token = crypto.randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(token), userId, expires.toISOString());
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: opts.secureCookies,
      expires,
      path: "/",
    });
  }

  router.post("/register", limiter, async (req, res) => {
    const body = registerSchema.parse(req.body);
    const existing = db.prepare("SELECT 1 FROM users WHERE email = ?").get(body.email);
    if (existing) {
      res.status(409).json({ error: "An account with that email already exists. Try signing in." });
      return;
    }
    const user: UserInfo = { id: crypto.randomUUID(), email: body.email, name: body.name };
    const now = new Date().toISOString();
    db.prepare("INSERT INTO users (id, email, name, password_hash, created_at, policy_version, policy_accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      user.id, user.email, user.name, await hashPassword(body.password), now, POLICY_VERSION, now,
    );
    startSession(res, user.id);
    res.locals.activityUser = user.id;
    res.status(201).json({ user: withAdmin(user) });
  });

  router.post("/login", limiter, async (req, res) => {
    const body = loginSchema.parse(req.body);
    const row = db.prepare("SELECT id, email, name, password_hash, policy_version, suspended_at FROM users WHERE email = ?").get(body.email) as
      | (UserInfo & { password_hash: string; policy_version: string | null; suspended_at: string | null })
      | undefined;
    // Hash even when the user doesn't exist so response time doesn't reveal which emails are registered.
    const ok = row ? await verifyPassword(body.password, row.password_hash) : (await hashPassword(body.password), false);
    if (!row || !ok) {
      res.status(401).json({ error: "Email or password is incorrect." });
      return;
    }
    if (row.suspended_at) {
      res.status(403).json({ error: suspendedMessage(opts.contact ?? null), code: "suspended" });
      return;
    }
    startSession(res, row.id);
    res.locals.activityUser = row.id;
    res.json({
      user: withAdmin({ id: row.id, email: row.email, name: row.name, ...(row.policy_version !== POLICY_VERSION ? { needsPolicy: true } : {}) }),
    });
  });

  router.post("/logout", (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  // Agreeing to the current Usage Policy (people who registered before it, or before a new version).
  router.post("/accept-policy", (req, res) => {
    if (!req.user) return void res.status(401).json({ error: "Please sign in." });
    const version = z.object({ version: z.string().max(40) }).parse(req.body).version;
    if (version !== POLICY_VERSION) return void res.status(409).json({ error: "The Usage Policy has just been updated. Please reload the page and read the new version." });
    db.prepare("UPDATE users SET policy_version = ?, policy_accepted_at = ? WHERE id = ?").run(POLICY_VERSION, new Date().toISOString(), req.user.id);
    const { needsPolicy: _, ...user } = req.user;
    res.json({ user: withAdmin(user) });
  });

  // The policy's version and who to contact (shown in it), for the sign-up page and /policy.
  router.get("/policy", (_req, res) => {
    res.json({ version: POLICY_VERSION, contact: opts.contact ?? null });
  });

  router.get("/me", (req, res) => {
    res.json({ user: req.user ? withAdmin(req.user) : null });
  });

  return router;
}

/** Attaches req.user when a valid session cookie is present. */
export function loadUser(db: DB) {
  const lookup = db.prepare(
    "SELECT u.id, u.email, u.name, u.policy_version, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.suspended_at IS NULL",
  );
  const purge = db.prepare("DELETE FROM sessions WHERE expires_at < ?");
  let lastPurge = 0;
  return (req: Request, _res: Response, next: NextFunction) => {
    if (Date.now() - lastPurge > 3600_000) {
      purge.run(new Date().toISOString());
      lastPurge = Date.now();
    }
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      const row = lookup.get(sha256(token)) as (UserInfo & { expires_at: string; policy_version: string | null }) | undefined;
      if (row && row.expires_at > new Date().toISOString()) {
        req.user = { id: row.id, email: row.email, name: row.name, ...(row.policy_version !== POLICY_VERSION ? { needsPolicy: true } : {}) };
      }
    }
    next();
  };
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "Please sign in." });
    return;
  }
  if (req.user.needsPolicy) {
    res.status(403).json({ error: "Please agree to the Usage Policy to continue.", code: "policy" });
    return;
  }
  next();
}
