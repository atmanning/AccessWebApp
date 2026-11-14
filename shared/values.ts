import { IMAGE_ID, type CellValue, type Field } from "./model.js";
import { parseAccessDate } from "./dates.js";

export type ParseResult = { ok: true; value: CellValue } | { ok: false; error: string };

const NUMBER_LIMITS: Record<string, [number, number, boolean]> = {
  Byte: [0, 255, true],
  Integer: [-32768, 32767, true],
  Long: [-2147483648, 2147483647, true],
  Single: [-3.4e38, 3.4e38, false],
  Double: [-Number.MAX_VALUE, Number.MAX_VALUE, false],
};

/** Turns what the user typed into a stored value, the way Access validates a cell. */
export function parseInput(field: Field, input: string | boolean): ParseResult {
  if (typeof input === "boolean") return { ok: true, value: input };
  const s = input.trim();
  if (s === "") return { ok: true, value: field.type === "YesNo" ? false : null };
  switch (field.type) {
    case "ShortText": {
      const max = field.size ?? 255;
      if (input.length > max) return { ok: false, error: `${field.name} can hold up to ${max} characters, and this is ${input.length}. Please shorten it.` };
      return { ok: true, value: input };
    }
    case "LongText":
      return { ok: true, value: input };
    case "AutoNumber":
    case "Number": {
      const n = Number(s.replace(/,/g, ""));
      const [min, max, whole] = NUMBER_LIMITS[field.numberSize ?? "Long"];
      if (!Number.isFinite(n)) return { ok: false, error: `${field.name} needs a number, like ${whole ? "42" : "42 or 3.5"}. Please re-try.` };
      const v = whole ? Math.round(n) : n;
      if (v < min || v > max) return { ok: false, error: `${field.name} needs a number from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}. Please re-try.` };
      return { ok: true, value: v };
    }
    case "Currency": {
      const n = Number(s.replace(/[$,\s]/g, ""));
      if (!Number.isFinite(n)) return { ok: false, error: `${field.name} needs an amount, like 12.50. Please re-try.` };
      return { ok: true, value: Math.round(n * 10000) / 10000 };
    }
    case "DateTime": {
      const d = parseAccessDate(s);
      if (!d) return { ok: false, error: `${field.name} needs a date, like 12/31/2026. Please re-try, or pick one from the calendar.` };
      return { ok: true, value: d };
    }
    case "YesNo":
      return { ok: true, value: /^(yes|true|-1|1|on|y)$/i.test(s) };
    case "Image":
      // Pictures are added by choosing or dropping a file; the cell keeps the stored picture's id.
      return IMAGE_ID.test(s) ? { ok: true, value: s } : { ok: false, error: `${field.name} holds a picture. Double-click the cell, or drop an image file on it.` };
  }
}

const currency = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });

export function formatValue(field: Pick<Field, "type"> | undefined, v: CellValue | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  switch (field?.type) {
    case "Currency":
      return typeof v === "number" ? currency.format(v) : String(v);
    case "DateTime":
      return formatDate(String(v));
    case "YesNo":
      return v === true || v === 1 ? "Yes" : "No";
    case "Image":
      return "(picture)";
    default:
      return typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);
  }
}

export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso);
  if (!m) return iso;
  const date = `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
  if (!m[4]) return date;
  let h = Number(m[4]);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${date} ${h}:${m[5]} ${ap}`;
}

/** Value shown in an edit box (raw rather than formatted, so it round-trips). */
export function editText(field: Field, v: CellValue | undefined): string {
  if (v === null || v === undefined) return "";
  if (field.type === "DateTime") return formatDate(String(v));
  return String(v);
}

/** Converts data when a field's type changes. Returns how many values couldn't be kept. */
export function convertValue(field: Field, v: CellValue | undefined): { value: CellValue; lost: boolean } {
  if (v === null || v === undefined || v === "") return { value: field.type === "YesNo" ? false : null, lost: false };
  const asText = typeof v === "boolean" ? (v ? "Yes" : "No") : field.type === "DateTime" ? String(v) : String(v);
  const r = parseInput(field, asText);
  if (r.ok) return { value: r.value, lost: false };
  if (field.type === "ShortText") return { value: asText.slice(0, field.size ?? 255), lost: true };
  return { value: null, lost: true };
}

export function defaultFor(field: Field): CellValue {
  if (field.type === "YesNo") {
    return field.defaultValue ? /^(yes|true|-1|1)$/i.test(field.defaultValue.trim()) : false;
  }
  if (!field.defaultValue) return null;
  const d = field.defaultValue.trim();
  if (field.type === "DateTime" && /^(=?\s*(now|date)\(\))$/i.test(d)) {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString();
    return /now/i.test(d) ? local.slice(0, 16) : local.slice(0, 10);
  }
  const r = parseInput(field, d.replace(/^"(.*)"$/, "$1"));
  return r.ok ? r.value : null;
}

export function isNumericType(type: Field["type"] | undefined) {
  return type === "Number" || type === "Currency" || type === "AutoNumber";
}
