import type { CellValue, Field, FieldType } from "../../../shared/model";
import { parseAccessDate } from "../engine/accessSql";
import { formatValue } from "../engine/values";
import { downloadBlob } from "../api";

/** RFC 4180 CSV parser (quoted fields, embedded commas/newlines, "" escapes). Also accepts tabs/semicolons. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = [",", "\t", ";"].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

/** Guesses an Access type for a column of imported text, like the import wizard does. */
export function inferType(values: string[]): FieldType {
  const vals = values.map((v) => v.trim()).filter(Boolean);
  if (!vals.length) return "ShortText";
  if (vals.every((v) => /^(yes|no|true|false)$/i.test(v))) return "YesNo";
  if (vals.every((v) => /^-?\$\s?[\d,]*\.?\d+$/.test(v))) return "Currency";
  if (vals.every((v) => /^-?[\d,]*\.?\d+(e[-+]?\d+)?$/i.test(v) && !/^0\d/.test(v))) return "Number";
  if (vals.every((v) => parseAccessDate(v))) return "DateTime";
  if (vals.some((v) => v.length > 255)) return "LongText";
  return "ShortText";
}

export function exportCsv(name: string, columns: string[], rows: CellValue[][], fields?: (Field | undefined)[]) {
  const esc = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const cell = (v: CellValue, f?: Field) => {
    if (v === null || v === undefined) return "";
    if (f?.type === "Currency" && typeof v === "number") return String(v);
    if (f?.type === "DateTime") return String(v).replace("T", " ");
    return formatValue(f, v);
  };
  const lines = [columns.map(esc).join(","), ...rows.map((r) => r.map((v, i) => esc(cell(v, fields?.[i]))).join(","))];
  downloadBlob(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }), `${name}.csv`);
}
