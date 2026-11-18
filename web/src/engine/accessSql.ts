/**
 * Translates the Access SQL dialect users type (and Access exports) into SQLite,
 * which runs the queries in the browser:
 *   "text"        -> 'text'          (Access double quotes are string literals)
 *   #2026-01-31#  -> '2026-01-31'    (date literals; also m/d/yyyy)
 *   a & b         -> a || b          (string concatenation)
 *   LIKE "A*"     -> LIKE 'A%'       (* and ? wildcards)
 *   Yes / No      -> 1 / 0
 *   IsNull(x)     -> acc_isnull(x)  (ISNULL is a keyword in SQLite)
 *   DISTINCTROW   -> (dropped)
 *   Form![ID], [Forms]![Orders]![ID], [TempVars]![X] -> the value, as a literal (NULL when unknown)
 *   Table!Field   -> Table.Field
 * [Bracketed] identifiers, True/False, IIf and most operators already work in SQLite.
 */

/** `start` is the token's offset in the original SQL. */
export type Token = { kind: "str" | "ident" | "date" | "word" | "other" | "ws"; text: string; start: number };

export class SqlSyntaxError extends Error {}

export function tokenize(sql: string): Token[] {
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
      tokens.push({ kind: "str", text: value, start: i });
      i = j + 1;
    } else if (c === "[") {
      const end = sql.indexOf("]", i);
      if (end < 0) throw new SqlSyntaxError("A [name] is missing its closing bracket.");
      // Access names can't start or end with spaces, so [Retired Date ] is [Retired Date].
      tokens.push({ kind: "ident", text: `[${sql.slice(i + 1, end).trim()}]`, start: i });
      i = end + 1;
    } else if (c === "#") {
      const end = sql.indexOf("#", i + 1);
      if (end < 0) throw new SqlSyntaxError("A #date# is missing its closing #.");
      tokens.push({ kind: "date", text: sql.slice(i + 1, end), start: i });
      i = end + 1;
    } else if (/\s/.test(c)) {
      let j = i;
      while (j < sql.length && /\s/.test(sql[j])) j++;
      tokens.push({ kind: "ws", text: sql.slice(i, j), start: i });
      i = j;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      tokens.push({ kind: "word", text: sql.slice(i, j), start: i });
      i = j;
    } else {
      tokens.push({ kind: "other", text: c, start: i });
      i++;
    }
  }
  return tokens;
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export { parseAccessDate } from "../../../shared/dates.js";
import { parseAccessDate } from "../../../shared/dates.js";
import { resolveQualified, type ExprValue } from "./expr";

function likePattern(s: string) {
  // Access: * any run, ? one char, # one digit. SQLite LIKE has % and _ only.
  return s.replace(/\*/g, "%").replace(/[?#]/g, "_");
}

/** Where references to forms in a query's SQL ([Forms]![Orders]![ID], Form![ID]…) get their values. */
export interface SqlRefs {
  /** A control or field of the form the SQL belongs to (a combo box's row source): Form![ID], Me![ID]. */
  form?: (name: string) => ExprValue | undefined;
  /** The form's name, for [Application].[CurrentObjectName]. */
  formName?: string;
  /** Tables and queries (lowercase): a table named Application or Form is a table, not a reference. */
  sources?: ReadonlySet<string>;
}

/** Names that start a reference to a form, a variable or the application rather than a table. */
const REF_ROOTS = new Set(["forms", "form", "me", "parent", "reports", "tempvars", "localvars", "screen", "currentproject", "application"]);

const bare = (t: Token) => (t.kind === "ident" ? t.text.slice(1, -1) : t.text);

function sqlLiteral(v: ExprValue | undefined): string {
  if (v === null || v === undefined || v === "") return v === "" ? "''" : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return quote(v);
}

/** The value a reference in SQL stands for, like Access fills it in before running the query. */
function referenceValue(path: string[], refs: SqlRefs): ExprValue | undefined {
  const root = path[0].toLowerCase();
  if ((root === "form" || root === "me") && path.length >= 2) {
    const name = path.length > 2 && /^value$/i.test(path[path.length - 1]) ? path[path.length - 2] : path[path.length - 1];
    const v = refs.form?.(name);
    if (v !== undefined) return v;
  }
  if (root === "application" && path.length === 2 && /^currentobjectname$/i.test(path[1]) && refs.formName) return refs.formName;
  return resolveQualified(path);
}

export function translateAccessSql(sql: string, refs: SqlRefs = {}): string {
  const tokens = tokenize(sql);
  const out: string[] = [];
  let prevWord = "";
  const nextSolid = (i: number) => {
    let j = i + 1;
    while (tokens[j]?.kind === "ws") j++;
    return tokens[j];
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // A reference: name!name, [name].[name]… (no spaces between the parts).
    if (t.kind === "word" || t.kind === "ident") {
      const parts = [t];
      const seps: string[] = [];
      let j = i;
      while (
        tokens[j + 1]?.kind === "other" &&
        (tokens[j + 1].text === "!" || tokens[j + 1].text === ".") &&
        (tokens[j + 2]?.kind === "word" || tokens[j + 2]?.kind === "ident")
      ) {
        seps.push(tokens[j + 1].text);
        parts.push(tokens[j + 2]);
        j += 2;
      }
      if (parts.length > 1) {
        const path = parts.map(bare);
        const root = path[0].toLowerCase();
        if (REF_ROOTS.has(root) && (seps.includes("!") || root !== "parent") && !refs.sources?.has(root)) {
          out.push(sqlLiteral(referenceValue(path, refs)));
        } else {
          // Table!Field is Table.Field.
          out.push(parts.map((p) => p.text).join("."));
        }
        i = j;
        prevWord = "";
        continue;
      }
    }
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
        if (!d) throw new SqlSyntaxError(`#${t.text}# isn't a date. Please write it like #12/31/2026#.`);
        out.push(quote(d));
        break;
      }
      case "word": {
        const up = t.text.toUpperCase();
        if (up === "YES") out.push("1");
        else if (up === "NO") out.push("0");
        else if (up === "ALIKE") out.push("LIKE");
        else if (up === "MOD") out.push("%");
        else if (up === "DISTINCTROW") {
          // Access's "unique records" of the tables; the rows SQLite returns already are.
          while (tokens[i + 1]?.kind === "ws") i++;
          continue;
        } else if (up === "ISNULL" && nextSolid(i)?.text === "(") out.push("acc_isnull");
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
