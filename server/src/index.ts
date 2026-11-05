import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";
import { createExporter, createLimiter } from "./export.js";
import { createImporter } from "./accessImport.js";
import { createSecretBox } from "./mysql.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from both server/src (tsx) and server/dist/server/src (compiled).
const repoRoot = path.resolve(here, here.includes(`${path.sep}dist${path.sep}`) ? "../../../.." : "../..");

const env = process.env;
const production = env.NODE_ENV === "production";
const port = Number(env.PORT ?? 3001);
const dataDir = env.DATA_DIR ?? path.join(repoRoot, "data");

const db = openDatabase(path.join(dataDir, "access-web.db"));
const javaTool = {
  javaBin: env.JAVA_BIN ?? "java",
  jarPath: env.EXPORTER_JAR ?? path.join(repoRoot, "exporter/target/access-exporter.jar"),
  timeoutMs: Number(env.EXPORT_TIMEOUT_MS ?? 60_000),
  maxConcurrent: Number(env.EXPORT_CONCURRENCY ?? 2),
  maxHeap: env.EXPORT_MAX_HEAP ?? "512m",
};
// Imports and exports both start Java, so they share one concurrency limit.
const javaLimit = createLimiter(javaTool.maxConcurrent);
const exportAccdb = createExporter(javaTool, javaLimit);
const importAccess = createImporter(javaTool, javaLimit);

// Written by `npm run build` (scripts/write-build-info.mjs); Render also says which commit it deployed.
let build: { commit?: string | null; builtAt?: string | null } = {};
try {
  build = JSON.parse(fs.readFileSync(path.join(repoRoot, "server/dist/build-info.json"), "utf8"));
} catch {
  /* development: not built */
}

const app = createApp({
  version: { commit: build.commit || env.RENDER_GIT_COMMIT || null, builtAt: build.builtAt ?? null, startedAt: new Date().toISOString() },
  db,
  // Pictures in Image fields, per database (default 200 MB).
  images: { maxBytesPerProject: Number(env.IMAGE_QUOTA_MB ?? 200) * 1024 * 1024 },
  exportAccdb,
  importAccess,
  connections: {
    secrets: createSecretBox(dataDir, env.CONNECTION_SECRET),
    // Self-hosted installs that need databases on their own network can turn this on.
    allowPrivateHosts: env.ALLOW_PRIVATE_DB_HOSTS === "true",
  },
  secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === "true" : production,
  staticDir: env.STATIC_DIR ?? path.join(repoRoot, "web/dist"),
  trustProxy: env.TRUST_PROXY === "true",
});

// HOST=127.0.0.1 accepts connections from this computer only (the local launchers set it).
const host = env.HOST?.trim() || undefined;
const onListening = () => console.log(`Access Web listening on http://${host && host !== "0.0.0.0" ? host : "localhost"}:${port}`);
const server = host ? app.listen(port, host, onListening) : app.listen(port, onListening);
const shutdown = () => server.close(() => { db.close(); process.exit(0); });
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
