import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkProjectIntegrity, projectDocSchema, type ProjectDoc } from "../../shared/model.js";
import { fromExchangeDocument, type ExchangeDocument } from "../../shared/exchange.js";
import { createLimiter, type ExporterConfig, type Limiter } from "./export.js";

export class ImportError extends Error {
  status = 400;
}

/** Largest imported project we accept, so it can still be saved (the save limit is 25 MB of JSON). */
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 200_000;

/** Reads an uploaded .accdb/.mdb with the Java tool and returns it as a project document. */
export function createImporter(cfg: ExporterConfig, limit: Limiter = createLimiter(cfg.maxConcurrent)) {
  return (file: Buffer) => limit(() => importOnce(cfg, file));
}

async function importOnce(cfg: ExporterConfig, file: Buffer): Promise<{ doc: ProjectDoc; warnings: string[] }> {
  // Every Jet/ACE database has this text at byte 4 ("Standard Jet DB" or "Standard ACE DB").
  const sig = file.subarray(4, 19).toString("latin1");
  if (sig !== "Standard Jet DB" && sig !== "Standard ACE DB") {
    throw new ImportError("That file isn't a Microsoft Access database. Choose an .accdb or .mdb file.");
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "accessweb-import-"));
  const input = path.join(dir, `${crypto.randomUUID()}.accdb`);
  try {
    await fs.writeFile(input, file);
    const json = await new Promise<string>((resolve, reject) => {
      const child = spawn(cfg.javaBin, [`-Xmx${cfg.maxHeap}`, "-XX:+UseSerialGC", "-jar", cfg.jarPath, "--import", input, String(MAX_ROWS)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      let size = 0;
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new ImportError("The import took too long. Try a smaller database."));
      }, cfg.timeoutMs);
      child.stdout.on("data", (d: Buffer) => {
        size += d.length;
        if (size > MAX_DOC_BYTES * 2) {
          child.kill("SIGKILL");
          reject(new ImportError("This database is too large to import here (more than about 20 MB of data)."));
        } else out.push(d);
      });
      child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`Could not start the Access tool (${e.message}). Is Java installed?`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve(Buffer.concat(out).toString("utf8"));
        const lines = stderr.split("\n").filter((l) => l && !l.startsWith("Picked up JAVA_TOOL_OPTIONS"));
        if (lines.some((l) => l.includes("OutOfMemoryError"))) {
          return reject(new ImportError("This database is too large to import on this server."));
        }
        const msg = lines.find((l) => l.startsWith("Import failed:"))?.replace("Import failed: ", "");
        reject(new ImportError(msg || "The database couldn't be read."));
      });
    });

    const { doc, warnings } = fromExchangeDocument(JSON.parse(json) as ExchangeDocument);
    if (JSON.stringify(doc).length > MAX_DOC_BYTES) {
      throw new ImportError("This database is too large to store here (more than about 20 MB of data).");
    }
    const parsed = projectDocSchema.safeParse(doc);
    if (!parsed.success) {
      throw new ImportError(`The database has something this app can't store yet: ${parsed.error.issues[0]?.message}`);
    }
    const problems = checkProjectIntegrity(parsed.data);
    if (problems.length) throw new ImportError(problems[0]);
    return { doc: parsed.data, warnings };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
