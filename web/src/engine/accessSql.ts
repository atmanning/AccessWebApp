/**
 * Translates the Access SQL dialect users type (and Access exports) into SQLite,
 * which runs the queries in the browser:
 *   "text"        -> 'text'          (Access double quotes are string literals)
 *   #2026-01-31#  -> '2026-01-31'    (date literals; also m/d/yyyy)
 *   a & b         -> a || b          (string concatenation)
 *   LIKE "A*"     -> LIKE 'A%'       (* and ? wildcards)
 *   Yes / No      -> 1 / 0
 * [Bracketed] identifiers, True/False, IIf and most operators already work in SQLite.
 */

type Token = { kind: "str" | "ident" | "date" | "word" | "other" | "ws"; text: string };

export class SqlSyntaxError extends Error {}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      let value = "";
      for (;;) {
        if (j >= sql.length) throw new SqlSyntaxError("A text value is missing its closing quote.");
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            value += c;
            j += 2;
            continue;
          }
          break;
        }
        value += sql[j++];
      }
      tokens.push({ kind: "str", text: value });
      i = j + 1;
    } else if (c === "[") {
      const end = sql.indexOf("]", i);
      if (end < 0) throw new SqlSyntaxError("A [name] is missing its closing bracket.");
      tokens.push({ kind: "ident", text: sql.slice(i, end + 1) });
      i = end + 1;
    } else if (c === "#") {
      const end = sql.indexOf("#", i + 1);
      if (end < 0) throw new SqlSyntaxError("A #date# is missing its closing #.");
      tokens.push({ kind: "date", text: sql.slice(i + 1, end) });
      i = end + 1;
    } else if (/\s/.test(c)) {
      let j = i;
      while (j < sql.length && /\s/.test(sql[j])) j++;
      tokens.push({ kind: "ws", text: sql.slice(i, j) });
      i = j;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      tokens.push({ kind: "word", text: sql.slice(i, j) });
      i = j;
    } else {
      tokens.push({ kind: "other", text: c });
      i++;
    }
  }
  return tokens;
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Accepts yyyy-mm-dd[ hh:mm[:ss]] and m/d/yyyy[ h:mm[:ss] [AM|PM]]. */
export function parseAccessDate(text: string): string | null {
  const s = text.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  let y: number, mo: number, d: number, h = 0, mi = 0, sec = 0, hasTime = false;
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (m[4]) [h, mi, sec, hasTime] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0), true];
  } else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(s);
    if (!m) return null;
    [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 100) y += y < 30 ? 2000 : 1900;
    if (m[4]) {
      [h, mi, sec, hasTime] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0), true];
      if (m[7]?.toUpperCase() === "PM" && h < 12) h += 12;
      if (m[7]?.toUpperCase() === "AM" && h === 12) h = 0;
    }
  }
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  const iso = dt.toISOString();
  return hasTime ? (sec ? iso.slice(0, 19) : iso.slice(0, 16)) : iso.slice(0, 10);
}

function likePattern(s: string) {
  // Access: * any run, ? one char, # one digit. SQLite LIKE has % and _ only.
  return s.replace(/\*/g, "%").replace(/[?#]/g, "_");
}

export function translateAccessSql(sql: string): string {
  const tokens = tokenize(sql);
  const out: string[] = [];
  let prevWord = "";
  for (const t of tokens) {
    switch (t.kind) {
      case "ws":
        out.push(t.text);
        continue;
      case "str":
        out.push(quote(prevWord === "LIKE" ? likePattern(t.text) : t.text));
        break;
      case "ident":
        out.push(t.text);
        break;
      case "date": {
        const d = parseAccessDate(t.text);
        if (!d) throw new SqlSyntaxError(`#${t.text}# isn't a date I understand. Use #2026-12-31# or #12/31/2026#.`);
        out.push(quote(d));
        break;
      }
      case "word": {
        const up = t.text.toUpperCase();
        if (up === "YES") out.push("1");
        else if (up === "NO") out.push("0");
        else if (up === "ALIKE") out.push("LIKE");
        else if (up === "MOD") out.push("%");
        else out.push(t.text);
        break;
      }
      default:
        out.push(t.text === "&" ? "||" : t.text);
    }
    prevWord = t.kind === "word" ? t.text.toUpperCase() : "";
  }
  return out.join("").trim();
}

/** True when the statement only reads data. */
export function isSelect(sql: string): boolean {
  const first = tokenize(sql).find((t) => t.kind === "word");
  const w = first?.text.toUpperCase();
  return w === "SELECT" || w === "WITH";
}

/** Brackets a name for use in generated SQL. */
export const br = (name: string) => `[${name}]`;
