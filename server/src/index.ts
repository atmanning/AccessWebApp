import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";
import { createExporter } from "./export.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from both server/src (tsx) and server/dist/server/src (compiled).
const repoRoot = path.resolve(here, here.includes(`${path.sep}dist${path.sep}`) ? "../../../.." : "../..");

const env = process.env;
const production = env.NODE_ENV === "production";
const port = Number(env.PORT ?? 3001);
const dataDir = env.DATA_DIR ?? path.join(repoRoot, "data");

const db = openDatabase(path.join(dataDir, "access-web.db"));
const exportAccdb = createExporter({
  javaBin: env.JAVA_BIN ?? "java",
  jarPath: env.EXPORTER_JAR ?? path.join(repoRoot, "exporter/target/access-exporter.jar"),
  timeoutMs: Number(env.EXPORT_TIMEOUT_MS ?? 60_000),
  maxConcurrent: Number(env.EXPORT_CONCURRENCY ?? 2),
  maxHeap: env.EXPORT_MAX_HEAP ?? "512m",
});

const app = createApp({
  db,
  exportAccdb,
  secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === "true" : production,
  staticDir: env.STATIC_DIR ?? path.join(repoRoot, "web/dist"),
  trustProxy: env.TRUST_PROXY === "true",
});

const server = app.listen(port, () => console.log(`Access Web listening on http://localhost:${port}`));
const shutdown = () => server.close(() => { db.close(); process.exit(0); });
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
