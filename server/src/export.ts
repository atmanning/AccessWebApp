import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectDoc } from "../../shared/model.js";

/** The JSON contract read by exporter/src/main/java/.../AccessExporter.java. */
export interface ExportDocument {
  tables: {
    name: string;
    description?: string;
    columns: {
      name: string;
      type: string;
      size?: number;
      numberSize?: string;
      required?: boolean;
      primaryKey?: boolean;
      indexed?: string;
      description?: string;
      defaultValue?: string;
    }[];
    rows: unknown[][];
  }[];
  relationships: { fromTable: string; fromColumn: string; toTable: string; toColumn: string; enforce: boolean }[];
  queries: { name: string; sql: string }[];
}

export function toExportDocument(doc: ProjectDoc): ExportDocument {
  const tableById = new Map(doc.tables.map((t) => [t.id, t]));
  return {
    tables: doc.tables.map((t) => {
      // Pictures aren't written to the .accdb yet (they're stored apart from the document).
      const fields = t.fields.filter((f) => f.type !== "Image");
      return {
      name: t.name,
      description: t.description,
      columns: fields.map((f) => ({
        name: f.name,
        type: f.type,
        size: f.size,
        numberSize: f.numberSize,
        // Access refuses a Required field that already holds blanks, so only keep the flag when the data satisfies it.
        required: f.required && t.rows.every((r) => r[f.id] !== null && r[f.id] !== undefined && r[f.id] !== ""),
        primaryKey: f.primaryKey,
        indexed: f.indexed,
        description: f.description,
        defaultValue: f.defaultValue,
      })),
      rows: t.rows.map((r) => fields.map((f) => r[f.id] ?? null)),
      };
    }),
    relationships: doc.relationships.flatMap((r) => {
      const from = tableById.get(r.fromTable);
      const to = tableById.get(r.toTable);
      const ff = from?.fields.find((f) => f.id === r.fromField);
      const tf = to?.fields.find((f) => f.id === r.toField);
      if (!from || !to || !ff || !tf) return [];
      // Only ask Access to enforce integrity when the data already satisfies it.
      const keys = new Set(from.rows.map((row) => row[ff.id]));
      const consistent = to.rows.every((row) => row[tf.id] === null || row[tf.id] === undefined || keys.has(row[tf.id]));
      return [{ fromTable: from.name, fromColumn: ff.name, toTable: to.name, toColumn: tf.name, enforce: r.enforce && consistent }];
    }),
    queries: doc.queries.map((q) => ({ name: q.name, sql: q.sql })),
  };
}

export interface ExporterConfig {
  javaBin: string;
  jarPath: string;
  timeoutMs: number;
  maxConcurrent: number;
  /** Java heap limit for each export, e.g. "512m". Keep it well under the machine's memory. */
  maxHeap: string;
}

/** Runs async jobs at most `max` at a time (each Java process needs its own memory). */
export function createLimiter(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async function limit<T>(job: () => Promise<T>): Promise<T> {
    if (running >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await job();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

export type Limiter = ReturnType<typeof createLimiter>;

/** Runs the Jackcess exporter and returns the .accdb bytes. */
export function createExporter(cfg: ExporterConfig, limit: Limiter = createLimiter(cfg.maxConcurrent)) {
  return (doc: ProjectDoc): Promise<Buffer> => limit(() => exportOnce(cfg, doc));
}

async function exportOnce(cfg: ExporterConfig, doc: ProjectDoc): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "accessweb-"));
  const out = path.join(dir, `${crypto.randomUUID()}.accdb`);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cfg.javaBin, [`-Xmx${cfg.maxHeap}`, "-XX:+UseSerialGC", "-jar", cfg.jarPath, out], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Export timed out"));
      }, cfg.timeoutMs);
      child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`Could not start the exporter (${e.message}). Is Java installed?`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else {
          const msg = stderr.split("\n").filter((l) => l && !l.startsWith("Picked up JAVA_TOOL_OPTIONS")).pop();
          reject(new Error(msg || `Exporter exited with code ${code}`));
        }
      });
      child.stdin.on("error", () => { /* surfaced via close */ });
      child.stdin.end(JSON.stringify(toExportDocument(doc)));
    });
    return await fs.readFile(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
