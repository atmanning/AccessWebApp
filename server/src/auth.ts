import { Router, type NextFunction, type Request, type Response } from "express";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import type { DB } from "./db.js";
import type { UserInfo } from "../../shared/model.js";

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
});
const loginSchema = z.object({ email: z.string().trim().toLowerCase().max(254), password: z.string().max(200) });

export function authRouter(db: DB, opts: { secureCookies: boolean }) {
  const router = Router();
  const limiter = rateLimit(20, 15 * 60 * 1000);

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
    db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
      user.id, user.email, user.name, await hashPassword(body.password), new Date().toISOString(),
    );
    startSession(res, user.id);
    res.status(201).json({ user });
  });

  router.post("/login", limiter, async (req, res) => {
    const body = loginSchema.parse(req.body);
    const row = db.prepare("SELECT id, email, name, password_hash FROM users WHERE email = ?").get(body.email) as
      | (UserInfo & { password_hash: string })
      | undefined;
    // Hash even when the user doesn't exist so response time doesn't reveal which emails are registered.
    const ok = row ? await verifyPassword(body.password, row.password_hash) : (await hashPassword(body.password), false);
    if (!row || !ok) {
      res.status(401).json({ error: "Email or password is incorrect." });
      return;
    }
    startSession(res, row.id);
    res.json({ user: { id: row.id, email: row.email, name: row.name } });
  });

  router.post("/logout", (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  router.get("/me", (req, res) => {
    res.json({ user: req.user ?? null });
  });

  return router;
}

/** Attaches req.user when a valid session cookie is present. */
export function loadUser(db: DB) {
  const lookup = db.prepare(
    "SELECT u.id, u.email, u.name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
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
      const row = lookup.get(sha256(token)) as (UserInfo & { expires_at: string }) | undefined;
      if (row && row.expires_at > new Date().toISOString()) {
        req.user = { id: row.id, email: row.email, name: row.name };
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
  next();
}
