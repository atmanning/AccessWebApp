/**
 * Attachment and multiple-value fields, which the Java tool leaves out (they're "complex" columns).
 *
 * An Attachment field comes across as an Image field: Access databases use them mostly for
 * photos (employees, products), and the first picture of each record is kept. Other files
 * (PDFs, documents) and extra pictures are counted in the notes. A multiple-value field comes
 * across as text, its values separated by "; ".
 */
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { MAX_IMAGE_BYTES, type CellValue, type Field, type ProjectDoc } from "../../shared/model.js";
import { rid, unique } from "../../shared/exchange.js";
import { imageType } from "./images.js";

interface JetFile {
  name?: string;
  type?: string;
  data?: Uint8Array;
}
interface JetDb {
  tables(): string[];
  columns(table: string): { name: string; type: string }[];
  rows(table: string, o?: { start?: number; limit?: number }): { rows: Record<string, unknown>[]; next: number | null };
  free(): void;
}

export interface ImportedImage {
  id: string;
  mime: string;
  data: Buffer;
}

const SKIPPED = /^Skipped field '(.+)\.([^.']+)' \(Attachment \/ multi-value fields aren't supported yet\)\.$/;

/** Adds the complex fields the Java tool skipped; returns the pictures to store with the database. */
export function importComplexFields(file: Buffer, doc: ProjectDoc, warnings: string[]): ImportedImage[] {
  const skipped = warnings.map((w, i) => ({ i, m: SKIPPED.exec(w) })).filter((x) => x.m);
  if (!skipped.length) return [];
  let db: JetDb;
  try {
    db = (createRequire(import.meta.url)("jetdb-wasm") as { Database: { open(b: Uint8Array): JetDb } }).Database.open(file);
  } catch {
    return [];
  }
  const images: ImportedImage[] = [];
  const handled = new Set<number>();
  try {
    for (const { i, m } of skipped) {
      const [, tableName, column] = m!;
      const table = doc.tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase());
      if (!table) continue;
      let jetRows: Record<string, unknown>[] = [];
      try {
        let start: number | undefined;
        do {
          const part = db.rows(tableName, { start, limit: 2000 });
          jetRows.push(...part.rows);
          start = part.next ?? undefined;
        } while (start !== undefined && jetRows.length < 200_000);
      } catch {
        jetRows = [];
      }
      const values = jetRows.map((r) => r[column]);
      const isFiles = (v: unknown) => Array.isArray(v) && v.some((x) => x && typeof x === "object" && "data" in (x as object));
      const isValues = (v: unknown) => Array.isArray(v) && v.some((x) => x !== null && typeof x !== "object");
      const attachment = values.some(isFiles) || (!values.some(isValues) && /attach|photo|picture|image|logo|file|document/i.test(column));

      // The Access rows, matched to the imported ones by primary key (or by position).
      const pk = table.fields.filter((f) => f.primaryKey);
      const key = (v: unknown) => (v === null || v === undefined ? "" : String(v));
      let rowFor: (j: number) => number = (j) => (jetRows.length === table.rows.length ? j : -1);
      if (pk.length === 1) {
        const byKey = new Map(table.rows.map((r, idx) => [key(r[pk[0].id]), idx]));
        rowFor = (j) => byKey.get(key(jetRows[j][pk[0].name])) ?? -1;
      }

      const field: Field = { id: rid("f"), name: unique(column, new Set(table.fields.map((f) => f.name.toLowerCase()))), type: attachment ? "Image" : "ShortText" };
      if (!attachment) field.size = 255;
      table.fields.push(field);
      for (const r of table.rows) r[field.id] = null;

      let pictures = 0;
      let extra = 0;
      let unmatched = 0;
      values.forEach((v, j) => {
        if (!Array.isArray(v) || !v.length) return;
        const ri = rowFor(j);
        if (ri < 0) {
          unmatched++;
          return;
        }
        if (!attachment) {
          table.rows[ri][field.id] = v.map((x) => String(x)).join("; ").slice(0, 255) as CellValue;
          return;
        }
        let kept = false;
        for (const f of v as JetFile[]) {
          const data = f?.data ? Buffer.from(f.data) : null;
          const mime = data && data.length <= MAX_IMAGE_BYTES ? imageType(data) : null;
          if (!kept && data && mime) {
            const id = `img_${crypto.randomBytes(16).toString("hex")}`;
            images.push({ id, mime, data });
            table.rows[ri][field.id] = id;
            kept = true;
            pictures++;
          } else extra++;
        }
      });
      handled.add(i);
      const notes: string[] = [];
      if (attachment) {
        notes.push(`'${table.name}.${column}' (an Attachment field) came across as an Image field${pictures ? ` with ${pictures} picture${pictures === 1 ? "" : "s"}` : ""}.`);
        if (extra) notes.push(`${extra} other file${extra === 1 ? "" : "s"} in it (documents, or more than one picture per record) weren't imported.`);
      } else notes.push(`'${table.name}.${column}' (a multiple-value field) came across as text, its values separated by "; ".`);
      if (unmatched) notes.push(`${unmatched} record${unmatched === 1 ? "" : "s"} couldn't be matched, so ${unmatched === 1 ? "its" : "their"} values were left out.`);
      warnings[i] = notes.join(" ");
    }
  } finally {
    try {
      db.free();
    } catch {
      /* already freed */
    }
  }
  return images;
}
