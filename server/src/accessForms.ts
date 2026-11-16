/**
 * Forms and reports from an Access file. Access keeps their designs in MSysAccessStorage in an
 * undocumented binary format; jetdb (MIT/Apache, github.com/dominion525/jetdb) decodes it into
 * properties per form, section and control, much as SaveAsText writes them. This turns those into
 * this app's forms (a designed layout: controls placed in header, detail and footer) and reports
 * (record source, fields, grouping and sorting).
 *
 * Sizes in Access are twips (1440 per inch); here they're pixels (96 per inch): divide by 15.
 */
import { createRequire } from "node:module";
import type { FormControl, FormControlType, FormDef, FormLayout, FormSection, ProjectDoc, QueryDef, ReportDef, SourceRef } from "../../shared/model.js";
import { cleanName, rid, unique } from "../../shared/exchange.js";

type JetValue = string | number | boolean | null | Record<string, unknown>;
interface JetProp {
  id: number;
  name: string;
  value: JetValue;
}
interface JetControl {
  name: string;
  type: string;
  typeCode?: number;
  properties: JetProp[];
}
interface JetDesign {
  name: string;
  type: "Form" | "Report";
  properties: JetProp[];
  controls: JetControl[];
}
interface JetMacro {
  source?: { control?: string | null; event?: string };
  statements?: { kind: string; name?: string; arguments?: unknown[] }[];
}
interface JetDatabase {
  forms(): { name: string; type: "Form" | "Report" }[];
  formProperties(name: string, o: { type: string }): JetDesign;
  formStream(name: string, o: { type: string; stream: string }): Uint8Array;
  embeddedMacros(name: string, o: { type: string }): JetMacro[];
  modules(): { name: string; type: string }[];
  moduleSource(name: string): string;
  free(): void;
}

let jet: { Database: { open(bytes: Uint8Array): JetDatabase } } | null = null;
function jetdb() {
  // Loaded on first use: the WebAssembly module is a couple of megabytes.
  jet ??= createRequire(import.meta.url)("jetdb-wasm");
  return jet!;
}

/** acControlType: the low byte of jetdb's type codes. */
const AC = {
  label: 100,
  rectangle: 101,
  line: 102,
  image: 103,
  button: 104,
  option: 105,
  checkbox: 106,
  optionGroup: 107,
  boundObject: 108,
  textbox: 109,
  listbox: 110,
  combobox: 111,
  subform: 112,
  objectFrame: 114,
  pageBreak: 118,
  custom: 119,
  toggle: 122,
  tab: 123,
  page: 124,
  emptyCell: 127,
  detail: 152,
  header: 153,
  footer: 154,
  pageHeader: 155,
  pageFooter: 156,
  groupHeader: 157,
  groupFooter: 158,
} as const;

const px = (twips: number) => Math.round(twips / 15);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

class Props {
  private m = new Map<string, JetValue>();
  constructor(list: JetProp[]) {
    for (const p of list) if (!this.m.has(p.name)) this.m.set(p.name, p.value);
  }
  num(name: string, dflt: number): number {
    const v = this.m.get(name);
    return typeof v === "number" ? v : dflt;
  }
  str(name: string): string | undefined {
    const v = this.m.get(name);
    return typeof v === "string" && v !== "NotDefault" ? v : undefined;
  }
  /** A Yes/No stored only when it isn't its default ("NotDefault"), or as a number. */
  flipped(name: string): boolean {
    const v = this.m.get(name);
    return v === "NotDefault" || v === true;
  }
  has(name: string) {
    return this.m.has(name);
  }
}

/** Access colors are 0x00BBGGRR; negative values are system colors (left to the theme). */
function color(v: number | undefined): string | undefined {
  if (v === undefined || v < 0 || v > 0xffffff) return undefined;
  const r = v & 0xff;
  const g = (v >> 8) & 0xff;
  const b = (v >> 16) & 0xff;
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** Strips [brackets] and a table prefix: "[Owners].[City]" → "City". */
function bareField(s: string) {
  const parts = s.trim().split(/\.(?![^[]*\])/);
  return parts[parts.length - 1].replace(/^\[|\]$/g, "").trim();
}

/** The columns a SELECT statement returns (their aliases or field names), roughly. */
function selectColumns(sql: string): string[] {
  const m = /^\s*SELECT\s+(?:DISTINCTROW\s+|DISTINCT\s+|TOP\s+\d+\s+)*([\s\S]+?)\s+FROM\s/i.exec(sql);
  if (!m) return [];
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quote = "";
  for (const ch of m[1]) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((c) => {
    const as = /\s+AS\s+(\[[^\]]+\]|\S+)\s*$/i.exec(c);
    return bareField(as ? as[1] : c);
  });
}

const firstFromTable = (sql: string) => /\bFROM\s+(?:\(\s*)*(\[[^\]]+\]|[\w$#@]+)/i.exec(sql)?.[1]?.replace(/^\[|\]$/g, "");

/** The group levels of a report (Sorting and Grouping): field, and whether it has a group header. */
export function readGroupLevels(blob: Uint8Array): { field: string; header: boolean }[] {
  const b = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  // Access 2002+ layout (version 0x14 / 0x15); the 2000 format (0x13) is a different tree.
  if (b.length < 32 || (b[0] !== 0x14 && b[0] !== 0x15)) return [];
  let p = 14;
  const levels: { field: string; header: boolean }[] = [];
  const group = () => {
    const props = new Map<number, Buffer>();
    for (let guard = 0; guard < 5000; guard++) {
      const id = b.readUInt16LE(p);
      const len = b.readUInt32LE(p + 10);
      props.set(id, b.subarray(p + 14, p + 14 + len));
      const trailer = b.readUInt32LE(p + 14 + len);
      p += 18 + len;
      if (trailer >= 253 && trailer <= 255) return { props, trailer };
    }
    throw new Error("unexpected design layout");
  };
  const nodes = (trailer: number, depth: number) => {
    const n = trailer === 253 ? 0 : trailer === 254 ? 1 : ((p += 2), b.readUInt16LE(p - 2));
    for (let i = 0; i < n; i++) {
      const type = b.readUInt16LE(p);
      p += 6;
      const g = group();
      // 0x9F: a group level; 27 its Field/Expression, 175 Group Header = Yes.
      if (depth === 0 && type === 0x9f && g.props.has(27)) {
        const field = g.props.get(27)!.toString("utf16le").replace(/^=/, "");
        levels.push({ field: bareField(field), header: g.props.has(175) });
      }
      nodes(g.trailer, depth + 1);
    }
  };
  try {
    nodes(group().trailer, 0);
  } catch {
    /* keep what was read */
  }
  return levels;
}

/** What a command button's click did, from its VBA or embedded macro, when it's a common action. */
export function buttonAction(code: string): { action: FormControl["action"]; target?: { kind: "form" | "report"; name: string } } | null {
  const strings = new Map<string, string>();
  for (const m of code.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) strings.set(m[1].toLowerCase(), m[2]);
  const nameArg = (raw: string | undefined) => {
    if (!raw) return undefined;
    const t = raw.trim();
    const q = /^"([^"]*)"/.exec(t);
    return q ? q[1] : strings.get(t.split(/[\s,]/)[0].toLowerCase());
  };
  let m: RegExpExecArray | null;
  if ((m = /DoCmd\.OpenForm\s+([^\r\n]+)/i.exec(code))) {
    const name = nameArg(m[1]);
    if (name) return { action: "openForm", target: { kind: "form", name } };
  }
  if ((m = /DoCmd\.OpenReport\s+([^\r\n]+)/i.exec(code))) {
    const name = nameArg(m[1]);
    if (name) return { action: "openReport", target: { kind: "report", name } };
  }
  if (/acNewRec\b|acCmdRecordsGoToNew/i.test(code)) return { action: "newRecord" };
  if (/GoToRecord[^\r\n]*\bacNext\b/i.test(code)) return { action: "nextRecord" };
  if (/GoToRecord[^\r\n]*\bacPrevious\b/i.test(code)) return { action: "previousRecord" };
  if (/GoToRecord[^\r\n]*\bacFirst\b/i.test(code)) return { action: "firstRecord" };
  if (/GoToRecord[^\r\n]*\bacLast\b/i.test(code)) return { action: "lastRecord" };
  if (/acCmdSaveRecord|acSaveRecord\b|Me\.Dirty\s*=\s*False/i.test(code)) return { action: "saveRecord" };
  if (/acCmdDeleteRecord|DoMenuItem[^\r\n]*acDelete\b/i.test(code)) return { action: "deleteRecord" };
  if (/DoCmd\.Close\b/i.test(code)) return { action: "closeForm" };
  return null;
}

/** An embedded macro's click actions, as text buttonAction understands. */
function macroAsCode(m: JetMacro): string {
  const lines: string[] = [];
  const args = (a: unknown[] | undefined) =>
    (a ?? [])
      .map((x) => (typeof x === "object" && x !== null ? String((x as { value?: unknown }).value ?? "") : String(x ?? "")))
      .filter(Boolean);
  for (const s of m.statements ?? []) {
    if (s.kind !== "action" || !s.name) continue;
    const a = args(s.arguments);
    const n = s.name.toLowerCase();
    if (n === "openform") lines.push(`DoCmd.OpenForm "${a[0] ?? ""}"`);
    else if (n === "openreport") lines.push(`DoCmd.OpenReport "${a[0] ?? ""}"`);
    else if (n === "gotorecord") {
      const which = a.find((x) => /^(next|previous|first|last|new)$/i.test(x))?.toLowerCase() ?? "next";
      lines.push(which === "new" ? "acNewRec" : `GoToRecord ac${which[0].toUpperCase()}${which.slice(1)}`);
    } else if (n === "runmenucommand" || n === "runcommand") lines.push(`acCmd${a[0] ?? ""}`);
    else if (n === "saverecord") lines.push("acCmdSaveRecord");
    else if (n === "closewindow" || n === "close") lines.push("DoCmd.Close");
  }
  return lines.join("\n");
}

interface Lookup {
  byName: Map<string, SourceRef & { name: string }>;
  doc: ProjectDoc;
}

export interface ImportedDesigns {
  forms: FormDef[];
  reports: ReportDef[];
  /** Queries made for record sources and lists that were SQL statements. */
  queries: QueryDef[];
  warnings: string[];
}

/** Reads the forms and reports of an Access file and converts them for `doc` (its tables and queries). */
export function importFormsAndReports(file: Buffer, doc: ProjectDoc): ImportedDesigns {
  const out: ImportedDesigns = { forms: [], reports: [], queries: [], warnings: [] };
  let db: JetDatabase;
  try {
    db = jetdb().Database.open(file);
  } catch {
    return out;
  }
  try {
    convert(db, doc, out);
  } catch (e) {
    out.warnings.push(`Forms and reports couldn't be read from this file (${(e as Error).message}).`);
  } finally {
    try {
      db.free();
    } catch {
      /* already freed */
    }
  }
  return out;
}

function convert(db: JetDatabase, doc: ProjectDoc, out: ImportedDesigns) {
  const list = db.forms();
  if (!list.length) return;
  const lookup: Lookup = { byName: new Map(), doc };
  for (const t of doc.tables) lookup.byName.set(t.name.toLowerCase(), { kind: "table", id: t.id, name: t.name });
  for (const q of doc.queries) lookup.byName.set(q.name.toLowerCase(), { kind: "query", id: q.id, name: q.name });
  const takenQueries = new Set([...doc.tables, ...doc.queries].map((o) => o.name.toLowerCase()));

  /** Record sources and list sources: a table, a saved query, or SQL (saved as a new query). */
  const sourceFor = (raw: string | undefined, nameForSql: string): (SourceRef & { name: string }) | null => {
    if (!raw?.trim()) return null;
    const s = raw.trim();
    const named = lookup.byName.get(s.replace(/^\[|\]$/g, "").toLowerCase()) ?? lookup.byName.get(cleanName(s, "").toLowerCase());
    if (named) return named;
    if (/^\s*(SELECT|TRANSFORM|PARAMETERS)\b/i.test(s)) {
      const key = `sql:${s}`;
      const existing = lookup.byName.get(key);
      if (existing) return existing;
      const q: QueryDef = { id: rid("q"), name: unique(cleanName(nameForSql, "Query"), takenQueries), mode: "sql", sql: s.replace(/;\s*$/, "").slice(0, 100_000) };
      out.queries.push(q);
      const ref = { kind: "query" as const, id: q.id, name: q.name };
      lookup.byName.set(key, ref);
      lookup.byName.set(q.name.toLowerCase(), ref);
      return ref;
    }
    return null;
  };
  /** The table a source reads from (subforms show a table). */
  const tableOf = (ref: SourceRef & { name: string }) => {
    if (ref.kind === "table") return doc.tables.find((t) => t.id === ref.id);
    const q = [...doc.queries, ...out.queries].find((x) => x.id === ref.id);
    const from = q && firstFromTable(q.sql);
    return from ? doc.tables.find((t) => t.name.toLowerCase() === from.toLowerCase()) : undefined;
  };
  const columnsOf = (ref: SourceRef & { name: string }): string[] => {
    if (ref.kind === "table") return doc.tables.find((t) => t.id === ref.id)?.fields.map((f) => f.name) ?? [];
    const q = [...doc.queries, ...out.queries].find((x) => x.id === ref.id);
    return q ? selectColumns(q.sql) : [];
  };

  const designs = new Map<string, JetDesign>();
  for (const item of list) {
    try {
      designs.set(`${item.type}:${item.name}`, db.formProperties(item.name, { type: item.type }));
    } catch {
      out.warnings.push(`${item.type} '${item.name}' couldn't be read, so it was skipped.`);
    }
  }
  let vba: Map<string, string> | null = null;
  const moduleFor = (formName: string) => {
    if (!vba) {
      vba = new Map();
      try {
        for (const m of db.modules()) if (m.type === "Document") vba.set(m.name.toLowerCase(), "");
      } catch {
        /* no VBA project */
      }
    }
    const key = `form_${formName}`.toLowerCase();
    if (!vba.has(key)) return "";
    if (vba.get(key) === "") {
      try {
        vba.set(key, db.moduleSource(`Form_${formName}`) || " ");
      } catch {
        vba.set(key, " ");
      }
    }
    return vba.get(key)!;
  };

  const formNames = new Set<string>();
  const reportNames = new Set<string>();
  const formIdByAccessName = new Map<string, string>();
  const reportIdByAccessName = new Map<string, string>();
  for (const item of list) {
    const id = rid(item.type === "Form" ? "f" : "r");
    (item.type === "Form" ? formIdByAccessName : reportIdByAccessName).set(item.name.toLowerCase(), id);
  }
  const buttonTargets: { c: FormControl; kind: "form" | "report"; name: string }[] = [];
  const skippedKinds = new Map<string, number>();
  const skip = (what: string) => skippedKinds.set(what, (skippedKinds.get(what) ?? 0) + 1);

  for (const item of list) {
    const d = designs.get(`${item.type}:${item.name}`);
    if (!d) continue;
    const props = new Props(d.properties);
    const sourceText = props.str("RecordSource");
    const display = cleanName(item.name, item.type);
    const source = sourceFor(sourceText, `${display} source`);

    if (item.type === "Report") {
      const report = convertReport(db, item.name, d, props, source, columnsOf, out);
      if (report) {
        report.id = reportIdByAccessName.get(item.name.toLowerCase())!;
        report.name = unique(display, reportNames);
        out.reports.push(report);
      }
      continue;
    }

    if (!source && sourceText) {
      out.warnings.push(`Form '${item.name}' reads from '${sourceText.slice(0, 80)}', which wasn't imported, so it was imported without a record source. Choose one in Design View.`);
    }
    const layout: FormLayout = {
      width: clamp(px(props.num("Width", 7200)), 160, 4000),
      sections: { header: 0, detail: 16, footer: 0 },
      theme: "office",
      controls: [],
    };
    if (props.flipped("NavigationButtons") || !source) layout.navigationButtons = false;
    if (props.flipped("AllowEdits")) layout.allowEdits = false;
    if (props.flipped("AllowAdditions")) layout.allowAdditions = false;
    if (props.flipped("AllowDeletions")) layout.allowDeletions = false;
    const view = props.num("DefaultView", 0);
    if (view === 1 || view === 2) {
      out.warnings.push(`Form '${item.name}' shows ${view === 1 ? "continuous records" : "a datasheet"} in Access; here it shows one record at a time (open the table or a subform for a list).`);
    }

    const sourceTable = source ? tableOf(source) : undefined;
    const fieldType = (f: string | undefined) => (f ? sourceTable?.fields.find((x) => x.name.toLowerCase() === f.toLowerCase())?.type : undefined);
    const names = new Set<string>();
    const tabbed: { c: FormControl; index: number }[] = [];
    let section: FormSection | null = null;
    const vbaCode = moduleFor(item.name);
    let macros: JetMacro[] | null = null;

    for (const jc of d.controls) {
      const code = (jc.typeCode ?? 0) & 0xff;
      const p = new Props(jc.properties);
      // Sections: header, detail and footer; Access's page header and footer print only.
      if (code >= AC.detail && code <= AC.groupFooter) {
        section = code === AC.detail ? "detail" : code === AC.header ? "header" : code === AC.footer ? "footer" : null;
        if (section) {
          const h = px(p.num("Height", section === "detail" ? 3600 : 0));
          layout.sections[section] = section === "detail" ? clamp(h, 16, 4000) : clamp(h, 0, 2000);
          const back = color(p.num("BackColor", -1));
          if (back && back !== "#ffffff" && layout.sections[section] > 0) {
            // A section's color: a rectangle behind its controls.
            layout.controls.push({
              id: rid("c"),
              type: "rectangle",
              name: unique(`${jc.name || section}Background`.replace(/[.![\]`]/g, "_").slice(0, 60), names),
              section,
              x: 0,
              y: 0,
              w: layout.width,
              h: layout.sections[section],
              backColor: back,
              borderWidth: 0,
              radius: 0,
            });
          }
        }
        continue;
      }
      if (!section) continue;
      const kind = kindOf(code, p);
      if (!kind) {
        const what =
          code === AC.tab || code === AC.page || code === AC.emptyCell || code === AC.pageBreak
            ? null
            : code === AC.image
              ? "pictures (logos)"
              : code === AC.optionGroup
                ? "option group frames"
                : "charts, OLE objects and ActiveX controls";
        if (what) skip(what);
        continue;
      }
      const c: FormControl = {
        id: rid("c"),
        type: kind,
        name: unique(cleanName(jc.name, kind), names),
        section,
        x: clamp(px(p.num("Left", 0)), 0, 4000),
        y: clamp(px(p.num("Top", 0)), 0, 4000),
        w: clamp(px(p.num("Width", kind === "line" ? 0 : 1440)), 1, 4000),
        h: clamp(px(p.num("Height", kind === "line" ? 0 : 315)), 1, 4000),
      };
      const controlSource = p.str("ControlSource");
      const caption = p.str("Caption");
      if (controlSource && kind !== "label" && kind !== "button") c.field = controlSource.slice(0, 4000);
      if (caption && (kind === "label" || kind === "button")) c.caption = caption.replace(/&(?!&)/g, "").replace(/&&/g, "&").slice(0, 500);
      // A picture button's text is often a leftover "Command85"; its tooltip says what it does.
      const tip = p.str("ControlTipText");
      if (kind === "button" && p.has("PictureData") && tip) c.caption = tip.slice(0, 500);
      if (kind === "checkbox") c.caption = "";
      // Access labels are their own controls, so bound controls don't draw a built-in one.
      if (kind === "textbox" || kind === "combobox" || kind === "listbox" || kind === "checkbox" || kind === "image" || kind === "subform") c.labelPos = "none";
      if (kind === "textbox" && (p.num("ScrollBars", 0) === 2 || p.flipped("EnterKeyBehavior") || fieldType(c.field) === "LongText")) c.multiline = true;
      const fmt = p.str("Format");
      if (fmt && kind === "textbox") c.format = fmt.slice(0, 100);
      if (p.flipped("Visible")) c.hidden = true;
      if (p.flipped("Locked") || p.flipped("Enabled")) c.locked = true;
      if (p.flipped("TabStop")) c.tabStop = false;
      const fontSize = p.num("FontSize", 0);
      if (fontSize) c.fontSize = clamp(Math.round((fontSize * 96) / 72), 8, 72);
      if (p.num("FontWeight", 400) >= 600) c.bold = true;
      if (p.flipped("FontItalic")) c.italic = true;
      const align = p.num("TextAlign", 0);
      if (align >= 1 && align <= 3) c.align = (["left", "center", "right"] as const)[align - 1];
      const fore = color(p.num("ForeColor", -1));
      if (fore && kind !== "line" && kind !== "rectangle") c.color = fore;
      // Labels are see-through unless set otherwise; other controls are filled unless set otherwise.
      const backStyle = p.num("BackStyle", kind === "label" ? 0 : 1);
      const back = color(p.num("BackColor", -1));
      if (back && backStyle === 1 && kind !== "line") c.backColor = back;
      const border = color(p.num("BorderColor", -1));
      const borderStyle = p.has("BorderStyle") ? p.num("BorderStyle", 1) : p.num("OldBorderStyle", kind === "label" ? 0 : 1);
      if (kind === "line" || kind === "rectangle") {
        c.borderWidth = clamp(p.num("BorderWidth", 0) + 1, 1, 12);
        if (border) c.borderColor = border;
        if (kind === "rectangle") c.radius = 0;
      } else if (borderStyle === 0 && kind !== "label" && kind !== "button") c.borderWidth = 0;
      else if (border && kind !== "label" && kind !== "button") c.borderColor = border;

      if (kind === "combobox" || kind === "listbox") listSource(c, p, `${display} ${c.name} list`, sourceFor, columnsOf);
      if (kind === "subform") {
        const so = p.str("SourceObject") ?? "";
        const m = /^(Form|Report|Table|Query)\.(.+)$/i.exec(so);
        const objName = m ? m[2] : so;
        const objKind = m ? m[1].toLowerCase() : "form";
        let table: ReturnType<typeof tableOf>;
        if (objKind === "table" || objKind === "query") {
          const ref = sourceFor(objName, `${display} ${c.name} source`);
          table = ref ? tableOf(ref) : undefined;
        } else {
          const sub = designs.get(`Form:${objName}`) ?? designs.get(`Report:${objName}`);
          const subSource = sub && new Props(sub.properties).str("RecordSource");
          const ref = sourceFor(subSource, `${cleanName(objName, "Subform")} source`);
          table = ref ? tableOf(ref) : undefined;
        }
        if (!table) {
          out.warnings.push(`Subform '${jc.name}' on form '${item.name}' shows '${objName}', whose records couldn't be found, so it was skipped.`);
          continue;
        }
        c.sourceObject = table.id;
        const master = p.str("LinkMasterFields");
        const child = p.str("LinkChildFields");
        if (master && child) {
          c.linkMaster = bareField(master.split(";")[0]).slice(0, 64);
          c.linkChild = bareField(child.split(";")[0]).slice(0, 64);
          if (master.includes(";")) out.warnings.push(`Subform '${jc.name}' on form '${item.name}' is linked on several fields; only ${c.linkMaster} = ${c.linkChild} is used.`);
        }
      }
      if (kind === "button") {
        c.action = "none";
        c.variant = "secondary";
        const onClick = p.str("OnClick") ?? "";
        let codeText = "";
        if (/^\[Event Procedure\]$/i.test(onClick)) {
          const prefix = (p.str("EventProcPrefix") ?? jc.name).replace(/[^\w]/g, "_");
          const sub = new RegExp(`Sub\\s+${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_Click\\s*\\([\\s\\S]*?End Sub`, "i").exec(vbaCode);
          codeText = sub?.[0] ?? "";
        } else if (/^\[Embedded Macro\]$/i.test(onClick)) {
          try {
            macros ??= db.embeddedMacros(item.name, { type: "Form" });
          } catch {
            macros = [];
          }
          const mac = macros.find((x) => x.source?.control?.toLowerCase() === jc.name.toLowerCase() && /click/i.test(x.source?.event ?? ""));
          codeText = mac ? macroAsCode(mac) : "";
        }
        const act = codeText ? buttonAction(codeText) : null;
        if (act) {
          c.action = act.action;
          if (act.target) buttonTargets.push({ c, kind: act.target.kind, name: act.target.name });
        } else if (onClick) skip("button actions written in VBA or macros");
      }
      layout.controls.push(c);
      if (p.has("TabIndex") || kind === "textbox" || kind === "combobox" || kind === "listbox" || kind === "checkbox" || kind === "button" || kind === "subform") {
        tabbed.push({ c, index: p.num("TabIndex", 0) });
      }
    }
    // Boxes and lines go behind everything else (Access forms usually draw frames behind buttons and fields).
    const decor = (c: FormControl) => c.type === "rectangle" || c.type === "line";
    layout.controls = [...layout.controls.filter(decor), ...layout.controls.filter((c) => !decor(c))];
    // Section heights must hold their controls.
    for (const s of ["header", "detail", "footer"] as const) {
      const bottom = layout.controls.filter((c) => c.section === s && !c.name.endsWith("Background")).reduce((m, c) => Math.max(m, c.y + c.h), 0);
      if (bottom > layout.sections[s]) layout.sections[s] = s === "detail" ? clamp(bottom, 16, 4000) : clamp(bottom, 0, 2000);
    }
    const right = layout.controls.reduce((m, c) => Math.max(m, c.x + c.w), 0);
    if (right > layout.width) layout.width = clamp(right, 160, 4000);
    for (const c of layout.controls) if (c.type === "rectangle" && c.name.endsWith("Background")) c.w = layout.width;
    // Tab order: by section, then Access's Tab Index.
    const order = { header: 0, detail: 1, footer: 2 };
    tabbed.sort((a, b) => order[a.c.section] - order[b.c.section] || a.index - b.index);
    if (tabbed.length) layout.tabOrder = tabbed.map((t) => t.c.id);

    const fields = new Set((source ? columnsOf(source) : []).map((f) => f.toLowerCase()));
    const columns = [...new Set(layout.controls.map((c) => c.field).filter((f): f is string => !!f && !f.startsWith("=") && fields.has(f.toLowerCase())))];
    out.forms.push({
      id: formIdByAccessName.get(item.name.toLowerCase())!,
      name: unique(display, formNames),
      title: (props.str("Caption") ?? item.name).slice(0, 200),
      ...(source ? { source: { kind: source.kind, id: source.id } } : {}),
      columns: columns.slice(0, 255),
      layout,
    });
  }

  // Buttons that open a form or report: the imported one of that name.
  for (const b of buttonTargets) {
    const id = (b.kind === "form" ? formIdByAccessName : reportIdByAccessName).get(b.name.toLowerCase());
    const exists = id && (b.kind === "form" ? out.forms : out.reports).some((x) => x.id === id);
    if (exists) b.c.target = id;
    else {
      b.c.action = "none";
      skip("buttons that open forms or reports that weren't imported");
    }
  }
  for (const [what, n] of skippedKinds) {
    out.warnings.push(
      what === "button actions written in VBA or macros"
        ? `${n} button(s) run VBA or macros that can't run here; they were imported without an action (choose one in the Property Sheet).`
        : `${n} ${what} weren't imported.`,
    );
  }
}

function kindOf(code: number, p: Props): FormControlType | null {
  switch (code) {
    case AC.label:
      return "label";
    case AC.textbox:
      return "textbox";
    case AC.combobox:
      return "combobox";
    case AC.listbox:
      return "listbox";
    case AC.checkbox:
    case AC.option:
    case AC.toggle:
      return "checkbox";
    case AC.button:
      return "button";
    case AC.subform:
      return "subform";
    case AC.rectangle:
      return "rectangle";
    case AC.line:
      return "line";
    case AC.image:
    case AC.boundObject:
      // Pictures stored in a field come across; a picture pasted into the design doesn't.
      return p.str("ControlSource") ? "image" : null;
    default:
      return null;
  }
}

/** A combo or list box's choices: a typed list, or a table / query (SQL becomes a saved query). */
function listSource(
  c: FormControl,
  p: Props,
  sqlName: string,
  sourceFor: (raw: string | undefined, name: string) => (SourceRef & { name: string }) | null,
  columnsOf: (ref: SourceRef & { name: string }) => string[],
) {
  const type = p.str("RowSourceType") ?? "Table/Query";
  const raw = p.str("RowSource") ?? "";
  const colCount = Math.max(1, p.num("ColumnCount", 1));
  const bound = Math.max(1, p.num("BoundColumn", 1));
  if (/value list/i.test(type)) {
    const items: string[] = [];
    let cur = "";
    let q = false;
    for (const ch of raw) {
      if (ch === '"') q = !q;
      if (ch === ";" && !q) {
        items.push(cur);
        cur = "";
      } else cur += ch;
    }
    if (cur.trim()) items.push(cur);
    const values = items.map((v) => v.trim().replace(/^"(.*)"$/, "$1")).filter((_, i) => i % colCount === bound - 1);
    c.rowSourceType = "values";
    c.rowSource = values.join(";").slice(0, 4000);
    return;
  }
  const ref = sourceFor(raw, sqlName);
  if (!ref) {
    c.rowSourceType = "values";
    c.rowSource = "";
    return;
  }
  c.rowSourceType = ref.kind;
  c.rowSource = ref.id;
  const cols = columnsOf(ref);
  if (cols[bound - 1]) c.boundColumn = cols[bound - 1].slice(0, 64);
  // The column people see: the first with a width (Access hides the key with a 0 width).
  const widths = (p.str("ColumnWidths") ?? "").split(";").map((w) => parseFloat(w));
  const shown = cols.findIndex((_, i) => i < colCount && !(widths[i] === 0));
  if (cols[shown] && cols[shown] !== c.boundColumn) c.displayColumn = cols[shown].slice(0, 64);
}

/** A report: its record source, the fields of its detail section, and its grouping and sorting. */
function convertReport(
  db: JetDatabase,
  name: string,
  d: JetDesign,
  props: Props,
  source: (SourceRef & { name: string }) | null,
  columnsOf: (ref: SourceRef & { name: string }) => string[],
  out: ImportedDesigns,
): ReportDef | null {
  const sourceText = props.str("RecordSource");
  if (!source) {
    out.warnings.push(
      sourceText
        ? `Report '${name}' reads from '${sourceText.slice(0, 80)}', which wasn't imported, so the report was skipped.`
        : `Report '${name}' has no record source, so it was skipped.`,
    );
    return null;
  }
  const available = columnsOf(source);
  const known = new Map(available.map((f) => [f.toLowerCase(), f]));
  // Bound text boxes in the detail and group headers, left to right (top to bottom for stacked ones).
  let section = 0;
  const placed: { field: string; top: number; left: number; group: boolean }[] = [];
  let title: string | undefined;
  let calculated = 0;
  for (const jc of d.controls) {
    const code = (jc.typeCode ?? 0) & 0xff;
    const p = new Props(jc.properties);
    if (code >= AC.detail && code <= AC.groupFooter) {
      section = code;
      continue;
    }
    if (code === AC.label && section === AC.header && !title) title = p.str("Caption");
    const cs = p.str("ControlSource");
    if (!cs || (code !== AC.textbox && code !== AC.checkbox && code !== AC.combobox)) continue;
    if (section !== AC.detail && section !== AC.groupHeader) continue;
    if (cs.startsWith("=")) {
      calculated++;
      continue;
    }
    const f = known.get(bareField(cs).toLowerCase());
    if (f) placed.push({ field: f, top: p.num("Top", 0), left: p.num("Left", 0), group: section === AC.groupHeader });
  }
  placed.sort((a, b) => Number(b.group) - Number(a.group) || Math.round(a.top / 200) - Math.round(b.top / 200) || a.left - b.left);
  const columns = [...new Set(placed.map((x) => x.field))];

  let levels: { field: string; header: boolean }[] = [];
  try {
    levels = readGroupLevels(db.formStream(name, { type: "Report", stream: "blob" }));
  } catch {
    /* no grouping read */
  }
  const usable = levels.map((l) => ({ ...l, field: known.get(l.field.toLowerCase()) })).filter((l): l is { field: string; header: boolean } => !!l.field);
  const group = usable.find((l) => l.header);
  const sort = usable.find((l) => l !== group) ?? (props.str("OrderBy") ? { field: known.get(bareField(props.str("OrderBy")!.split(",")[0].replace(/\s+DESC$/i, "")).toLowerCase()) } : undefined);
  const notes: string[] = [];
  if (calculated) notes.push(`${calculated} calculated box(es)`);
  if (usable.filter((l) => l.header).length > 1) notes.push("more than one grouping level");
  if (notes.length) out.warnings.push(`Report '${name}' was simplified: ${notes.join(" and ")} aren't shown yet.`);

  const report: ReportDef = {
    id: "",
    name: "",
    title: (props.str("Caption") ?? title ?? name).slice(0, 200),
    source: { kind: source.kind, id: source.id },
    columns: (columns.length ? columns : available).slice(0, 255),
  };
  if (group?.field) report.groupBy = group.field;
  if (sort?.field && sort.field !== report.groupBy) report.sortBy = sort.field;
  return report;
}
