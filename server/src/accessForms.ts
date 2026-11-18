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
import type { FormControl, FormControlType, FormDef, FormLayout, FormSection, ProjectDoc, QueryDef, ReportControl, ReportDef, ReportLayout, SourceRef } from "../../shared/model.js";
import { cleanName, rid, unique } from "../../shared/exchange.js";
import type { MacroDef, MacroStep } from "../../shared/macros.js";
import { findProcedure, jetStatementsToSteps, vbaConstants, vbaEventCall, vbaProcedure, vbaToSteps, type JetStatement, type VbaProcedure } from "./accessMacros.js";

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
  statements?: JetStatement[];
}
interface JetDatabase {
  forms(): { name: string; type: "Form" | "Report" }[];
  formProperties(name: string, o: { type: string }): JetDesign;
  formStream(name: string, o: { type: string; stream: string }): Uint8Array;
  embeddedMacros(name: string, o: { type: string }): JetMacro[];
  modules(): { name: string; type: string }[];
  moduleSource(name: string): string;
  macros(o?: { system?: boolean }): string[];
  macro(name: string): JetMacro;
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
export function readGroupLevels(blob: Uint8Array): { field: string; header: boolean; footer?: boolean; descending?: boolean }[] {
  const b = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  // Access 2002+ layout (version 0x14 / 0x15); the 2000 format (0x13) is a different tree.
  if (b.length < 32 || (b[0] !== 0x14 && b[0] !== 0x15)) return [];
  let p = 14;
  const levels: { field: string; header: boolean; footer?: boolean; descending?: boolean }[] = [];
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
        // 175 Group Header, 176 Group Footer, 174 Sort Order (descending).
        levels.push({ field: bareField(field), header: g.props.has(175), ...(g.props.has(176) ? { footer: true } : {}), ...(g.props.has(174) ? { descending: true } : {}) });
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

/** A button's macro as one of the simple button actions, when it's just that (no arguments to keep). */
export function simpleButtonAction(steps: MacroStep[]): { action: FormControl["action"]; target?: { kind: "form" | "report"; name: string } } | null {
  if (steps.length !== 1 || steps[0].kind !== "action") return null;
  const { action, args = {} } = steps[0];
  const only = (...keys: string[]) => Object.keys(args).every((k) => keys.includes(k));
  const literal = (v: string | undefined) => !!v && !v.trim().startsWith("=");
  switch (action) {
    case "OpenForm":
      return only("FormName", "View") && literal(args.FormName) && !/design|datasheet/i.test(args.View ?? "") ? { action: "openForm", target: { kind: "form", name: args.FormName } } : null;
    case "OpenReport":
      return only("ReportName", "View") && literal(args.ReportName) && !/design|^print$/i.test(args.View ?? "") ? { action: "openReport", target: { kind: "report", name: args.ReportName } } : null;
    case "GoToRecord": {
      if (!only("Record", "ObjectType") || args.ObjectType) return null;
      const r = (args.Record ?? "Next").toLowerCase();
      return r === "next" ? { action: "nextRecord" } : r === "previous" ? { action: "previousRecord" } : r === "first" ? { action: "firstRecord" } : r === "last" ? { action: "lastRecord" } : r === "new" ? { action: "newRecord" } : null;
    }
    case "SaveRecord":
      return { action: "saveRecord" };
    case "DeleteRecord":
      return { action: "deleteRecord" };
    case "RunMenuCommand": {
      const c = (args.Command ?? "").toLowerCase();
      return c === "saverecord" ? { action: "saveRecord" } : c === "deleterecord" ? { action: "deleteRecord" } : c === "recordsgotonew" ? { action: "newRecord" } : c === "close" || c === "closewindow" ? { action: "closeForm" } : null;
    }
    case "CloseWindow":
      return !args.ObjectName ? { action: "closeForm" } : null;
  }
  return null;
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
  /** Named macros (Navigation Pane → Macros). */
  macros: MacroDef[];
  warnings: string[];
}

/** Reads the forms and reports of an Access file and converts them for `doc` (its tables and queries). */
export function importFormsAndReports(file: Buffer, doc: ProjectDoc): ImportedDesigns {
  const out: ImportedDesigns = { forms: [], reports: [], queries: [], macros: [], warnings: [] };
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
  }
  try {
    importMacros(db, out);
  } catch (e) {
    out.warnings.push(`Macros couldn't be read from this file (${(e as Error).message}).`);
  } finally {
    try {
      db.free();
    } catch {
      /* already freed */
    }
  }
  return out;
}

/** Named macros, as they are (AutoExec too: it runs when the database opens here as well). */
function importMacros(db: JetDatabase, out: ImportedDesigns) {
  const taken = new Set<string>();
  for (const name of db.macros()) {
    let steps: MacroStep[];
    try {
      steps = jetStatementsToSteps(db.macro(name).statements);
    } catch {
      out.warnings.push(`Macro '${name}' couldn't be read, so it was skipped.`);
      continue;
    }
    out.macros.push({ id: rid("mc"), name: unique(cleanName(name, "Macro"), taken), steps });
  }
}

/** Access's event properties and the VBA procedure names they run. */
const CONTROL_EVENT_PROPS = [
  { prop: "OnClick", jet: "OnClick", vba: "Click", ev: "onClick" },
  { prop: "OnDblClick", jet: "OnDblClick", vba: "DblClick", ev: "onDblClick" },
  { prop: "AfterUpdate", jet: "AfterUpdate", vba: "AfterUpdate", ev: "afterUpdate" },
] as const;
const FORM_EVENT_PROPS = [
  { prop: "OnOpen", jet: "OnOpen", vba: "Open", ev: "onLoad" },
  { prop: "OnLoad", jet: "OnLoad", vba: "Load", ev: "onLoad" },
  { prop: "OnCurrent", jet: "OnCurrent", vba: "Current", ev: "onCurrent" },
  { prop: "OnUnload", jet: "OnUnload", vba: "Unload", ev: "onClose" },
  { prop: "OnClose", jet: "OnClose", vba: "Close", ev: "onClose" },
] as const;
/** Events this app doesn't have, reported when they have code. */
const OTHER_EVENTS = ["BeforeUpdate", "OnChange", "OnEnter", "OnExit", "OnGotFocus", "OnLostFocus", "OnKeyDown", "OnKeyPress", "OnMouseDown", "BeforeInsert", "AfterInsert", "OnDelete", "OnTimer", "OnError", "OnDirty"];

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
  /** Const and Enum values from every module (status codes and the like that event code compares with). */
  let constants: Map<string, string> | null = null;
  /** Standard modules' code: their Subs and Functions can be called from event code. */
  const standard: string[] = [];
  const vbaConstantsAll = () => {
    if (constants) return constants;
    const sources: string[] = [];
    try {
      for (const m of db.modules()) {
        try {
          const src = db.moduleSource(m.name) || "";
          sources.push(src);
          if (m.type === "Standard") standard.push(src);
        } catch {
          /* unreadable module */
        }
      }
    } catch {
      /* no VBA project */
    }
    return (constants = vbaConstants(sources));
  };
  const procCache = new Map<string, VbaProcedure | null>();
  const standardProcedure = (name: string) => {
    const k = name.toLowerCase();
    if (!procCache.has(k)) {
      vbaConstantsAll();
      let hit: VbaProcedure | null = null;
      for (const src of standard) if ((hit = findProcedure(src, name))) break;
      procCache.set(k, hit);
    }
    return procCache.get(k)!;
  };
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
  const buttonTargets: { c: FormControl; kind: "form" | "report"; name: string; steps: MacroStep[] }[] = [];
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
    // Default View: 0 Single Form, 1 Continuous Forms (Access leaves it out then), 2 Datasheet, 5 Split Form.
    const view = props.num("DefaultView", 1);
    if (view === 1 && source) layout.defaultView = "continuous";
    else if (view === 2) layout.defaultView = "datasheet";
    else if (view === 5) layout.defaultView = "split";
    else if (view === 3 || view === 4) out.warnings.push(`Form '${item.name}' is a PivotTable or PivotChart in Access; here it shows one record at a time.`);

    const sourceTable = source ? tableOf(source) : undefined;
    const fieldType = (f: string | undefined) => (f ? sourceTable?.fields.find((x) => x.name.toLowerCase() === f.toLowerCase())?.type : undefined);
    const names = new Set<string>();
    const tabbed: { c: FormControl; index: number }[] = [];
    let section: FormSection | null = null;
    const vbaCode = moduleFor(item.name);
    let macros: JetMacro[] | null = null;
    let unconverted = 0;
    const vbaOpts = () => ({
      module: vbaCode,
      names: knownNames(),
      constants: vbaConstantsAll(),
      formName: item.name,
      procedures: (n: string) => findProcedure(vbaCode, n) ?? standardProcedure(n),
    });
    /** The form's control and field names (other names in VBA are variables). */
    const knownNames = () =>
      // Fields are unknown when the record source wasn't imported: then every bare name stays a field or control.
      !source && sourceText ? undefined : new Set([...d.controls.map((x) => x.name.toLowerCase()), ...(source ? columnsOf(source) : []).map((x) => x.toLowerCase())]);
    const otherEvents = new Set<string>();
    /** An event's steps: its embedded macro, its VBA procedure, or the named macro it runs. */
    const eventSteps = (value: string | undefined, control: string | null, jetEvent: string, procedure: string): MacroStep[] | undefined => {
      const v = value?.trim();
      // Embedded macros: found by control and event (some files don't set the event property).
      if (!v || /^\[Embedded Macro\]$/i.test(v)) {
        try {
          macros ??= db.embeddedMacros(item.name, { type: "Form" });
        } catch {
          macros = [];
        }
        const mac = macros.find((x) => (x.source?.control ?? null)?.toLowerCase() === control?.toLowerCase() && x.source?.event?.toLowerCase() === jetEvent.toLowerCase());
        return mac ? jetStatementsToSteps(mac.statements) : undefined;
      }
      if (/^\[Event Procedure\]$/i.test(v)) {
        const body = vbaProcedure(vbaCode, procedure);
        if (body === null) return undefined;
        const r = vbaToSteps(body, vbaOpts());
        unconverted += r.unconverted.length;
        return r.steps;
      }
      if (v.startsWith("=")) {
        const r = vbaEventCall(v, vbaOpts());
        if (r) {
          unconverted += r.unconverted.length;
          return r.steps;
        }
        unconverted++;
        return [{ kind: "comment", text: `Not converted: this event calls the VBA function ${v.slice(1)}.` }];
      }
      return [{ kind: "action", action: "RunMacro", args: { MacroName: v } }];
    };

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
        const subFormId = objKind === "form" ? formIdByAccessName.get(objName.toLowerCase()) : undefined;
        if (subFormId) {
          // The form itself, shown in its own Default View (a datasheet, continuous records…).
          c.sourceForm = subFormId;
        } else if (objKind === "table" || objKind === "query") {
          const ref = sourceFor(objName, `${display} ${c.name} source`);
          table = ref ? tableOf(ref) : undefined;
        } else {
          const sub = designs.get(`Form:${objName}`) ?? designs.get(`Report:${objName}`);
          const subSource = sub && new Props(sub.properties).str("RecordSource");
          const ref = sourceFor(subSource, `${cleanName(objName, "Subform")} source`);
          table = ref ? tableOf(ref) : undefined;
        }
        if (!table && !subFormId) {
          out.warnings.push(
            objName
              ? `Subform '${jc.name}' on form '${item.name}' shows '${objName}', whose records couldn't be found, so it was skipped.`
              : `Subform '${jc.name}' on form '${item.name}' gets its form from VBA as it opens, so it was imported empty: choose its Source Object in Design View.`,
          );
          if (objName) continue;
        }
        if (table && !subFormId) c.sourceObject = table.id;
        const master = p.str("LinkMasterFields");
        const child = p.str("LinkChildFields");
        if (master && child) {
          c.linkMaster = bareField(master.split(";")[0]).slice(0, 64);
          c.linkChild = bareField(child.split(";")[0]).slice(0, 64);
          if (master.includes(";")) out.warnings.push(`Subform '${jc.name}' on form '${item.name}' is linked on several fields; only ${c.linkMaster} = ${c.linkChild} is used.`);
        }
      }
      // Events: embedded macros, and VBA event procedures translated to macro steps.
      const prefix = (p.str("EventProcPrefix") ?? jc.name).replace(/[^\w]/g, "_");
      for (const e of CONTROL_EVENT_PROPS) {
        const steps = eventSteps(p.str(e.prop), jc.name, e.jet, `${prefix}_${e.vba}`);
        if (steps?.length) c.events = { ...c.events, [e.ev]: steps };
      }
      for (const e of OTHER_EVENTS) if (p.str(e)) otherEvents.add(e.replace(/^On/, "On "));
      if (kind === "button") {
        c.action = "none";
        c.variant = "secondary";
        const simple = c.events?.onClick ? simpleButtonAction(c.events.onClick) : null;
        if (simple) {
          // A plain Next / New / Open Form button: the built-in action (it greys out at the last record).
          c.action = simple.action;
          if (simple.target) buttonTargets.push({ c, kind: simple.target.kind, name: simple.target.name, steps: c.events!.onClick! });
          delete c.events!.onClick;
          if (!Object.keys(c.events!).length) delete c.events;
        }
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
    const formEvents: NonNullable<FormDef["events"]> = {};
    for (const e of FORM_EVENT_PROPS) {
      const steps = eventSteps(props.str(e.prop), null, e.jet, `Form_${e.vba}`);
      if (steps?.length) formEvents[e.ev] = [...(formEvents[e.ev] ?? []), ...steps];
    }
    for (const e of OTHER_EVENTS) if (props.str(e)) otherEvents.add(e.replace(/^On/, "On "));
    const mapped = new Set([...CONTROL_EVENT_PROPS, ...FORM_EVENT_PROPS].map((e) => e.jet.toLowerCase()));
    for (const m of (macros as JetMacro[] | null) ?? []) {
      const ev = m.source?.event;
      if (ev && !mapped.has(ev.toLowerCase())) otherEvents.add(ev.replace(/^On(?=[A-Z])/, "On "));
    }
    if (unconverted) {
      out.warnings.push(`Form '${item.name}': ${unconverted} line(s) of VBA couldn't become macro actions; they're kept as comments in its macros (Design View → Property Sheet → Event → …).`);
    }
    if (otherEvents.size) out.warnings.push(`Form '${item.name}' has code for events this app doesn't run yet (${[...otherEvents].join(", ")}).`);
    out.forms.push({
      ...(Object.keys(formEvents).length ? { events: formEvents } : {}),
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
      // Keep it as a macro: it says which form it opens, and fails with that name if it's missing.
      b.c.action = "none";
      b.c.events = { ...b.c.events, onClick: b.steps };
    }
  }
  for (const [what, n] of skippedKinds) {
    out.warnings.push(
      `${n} ${what} weren't imported.`,
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

/** Paper sizes Access stores (DEVMODE dmPaperSize) that reports here know. */
const PAPER: Record<number, "letter" | "legal" | "tabloid" | "a4" | "a5"> = { 1: "letter", 5: "legal", 3: "tabloid", 9: "a4", 11: "a5" };

const bytesOf = (v: JetValue | undefined): Buffer | null => (v && typeof v === "object" ? Buffer.from(Object.values(v as Record<string, number>)) : null);

/**
 * A report as a designed layout (Report Design View): page setup from its print settings, every
 * section with its height, color and Force New Page, the group levels from Sorting and Grouping,
 * and its controls in place.
 */
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

  // Page setup: margins (PrtMip, twips) and paper size and orientation (PrtDevMode).
  const margins = { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 };
  const mip = bytesOf(d.properties.find((p) => p.name === "PrtMip")?.value);
  if (mip && mip.length >= 16) {
    const inch = (o: number) => clamp(Math.round((mip.readInt32LE(o) / 1440) * 100) / 100, 0, 4);
    Object.assign(margins, { left: inch(0), top: inch(4), right: inch(8), bottom: inch(12) });
  }
  let size: "letter" | "legal" | "tabloid" | "a4" | "a5" = "letter";
  let landscape = false;
  const dev = bytesOf(d.properties.find((p) => p.name === "PrtDevMode")?.value);
  if (dev && dev.length >= 48) {
    if (dev.readUInt16LE(44) === 2) landscape = true;
    size = PAPER[dev.readUInt16LE(46)] ?? "letter";
  }

  // Group levels (Sorting and Grouping), each a group here; levels without a header or footer just sort.
  let levels: { field: string; header: boolean; footer?: boolean; descending?: boolean }[] = [];
  try {
    levels = readGroupLevels(db.formStream(name, { type: "Report", stream: "blob" }));
  } catch {
    /* no grouping read */
  }
  const groups: ReportLayout["groups"] = levels.map((lv, i) => ({ id: `g${i}`, field: known.get(lv.field.toLowerCase()) ?? lv.field, header: 0, footer: 0, ...(lv.descending ? { descending: true } : {}) }));

  const layout: ReportLayout = {
    page: { size, ...(landscape ? { landscape: true } : {}), margins },
    width: clamp(px(props.num("Width", 10080)), 48, 4600),
    sections: { reportHeader: 0, pageHeader: 0, detail: 0, pageFooter: 0, reportFooter: 0 },
    groups,
    sorts: [],
    // Access's default font: Calibri 11 pt.
    fontSize: 15,
    controls: [],
  };
  const sectionProps: NonNullable<ReportLayout["sectionProps"]> = {};
  const names = new Set<string>();
  let key: string | null = null;
  let skipped = 0;
  for (const jc of d.controls) {
    const code = (jc.typeCode ?? 0) & 0xff;
    const p = new Props(jc.properties);
    if (code >= AC.detail && code <= AC.groupFooter) {
      const level = p.num("BreakLevel", 0);
      key =
        code === AC.detail ? "detail"
        : code === AC.header ? "reportHeader"
        : code === AC.footer ? "reportFooter"
        : code === AC.pageHeader ? "pageHeader"
        : code === AC.pageFooter ? "pageFooter"
        : groups[level] ? `${code === AC.groupHeader ? "gh" : "gf"}:${groups[level].id}` : null;
      if (!key) continue;
      const h = clamp(px(p.num("Height", 0)), 0, key === "detail" || key.startsWith("report") ? 4000 : 2000);
      if (key.startsWith("g")) {
        const g = groups[level];
        // A group section of no height still counts (it can force a new page).
        g[key.startsWith("gh") ? "header" : "footer"] = Math.max(1, h);
      } else layout.sections[key as keyof ReportLayout["sections"]] = h;
      const sp: NonNullable<ReportLayout["sectionProps"]>[string] = {};
      const back = color(p.num("BackColor", -1));
      if (back && back !== "#ffffff") sp.backColor = back;
      const fnp = p.num("ForceNewPage", 0);
      if (fnp === 1 || fnp === 3) sp.forceNewPage = "before";
      else if (fnp === 2) sp.forceNewPage = "after";
      if (p.flipped("Visible")) sp.hidden = true;
      if (Object.keys(sp).length) sectionProps[key] = sp;
      continue;
    }
    if (!key) continue;
    const kind: ReportControl["type"] | null =
      code === AC.label ? "label"
      : code === AC.textbox || code === AC.combobox || code === AC.listbox ? "textbox"
      : code === AC.checkbox || code === AC.option || code === AC.toggle ? "checkbox"
      : code === AC.rectangle ? "rectangle"
      : code === AC.line ? "line"
      : (code === AC.image || code === AC.boundObject) && p.str("ControlSource") ? "image"
      : null;
    if (!kind) {
      if (code !== AC.emptyCell && code !== AC.pageBreak) skipped++;
      continue;
    }
    const c: ReportControl = {
      id: rid("c"),
      type: kind,
      name: unique(cleanName(jc.name, kind), names),
      section: key,
      x: clamp(px(p.num("Left", 0)), 0, 4000),
      y: clamp(px(p.num("Top", 0)), 0, 4000),
      w: clamp(px(p.num("Width", kind === "line" ? 0 : 1440)), 1, 4000),
      h: clamp(px(p.num("Height", kind === "line" ? 0 : 315)), 1, 4000),
    };
    const cs = p.str("ControlSource");
    if (cs && kind !== "label") c.field = cs.startsWith("=") ? cs.slice(0, 4000) : (known.get(bareField(cs).toLowerCase()) ?? bareField(cs));
    const caption = p.str("Caption");
    if (kind === "label") c.caption = (caption ?? "").replace(/&(?!&)/g, "").replace(/&&/g, "&").slice(0, 500);
    if (kind === "checkbox") c.caption = "";
    const fmt = p.str("Format");
    if (fmt && kind === "textbox") c.format = fmt.slice(0, 100);
    if (p.flipped("Visible")) c.hidden = true;
    if (p.flipped("HideDuplicates")) c.hideDuplicates = true;
    const fontSize = p.num("FontSize", 0);
    if (fontSize) c.fontSize = clamp(Math.round((fontSize * 96) / 72), 8, 72);
    if (p.num("FontWeight", 400) >= 600) c.bold = true;
    if (p.flipped("FontItalic")) c.italic = true;
    const align = p.num("TextAlign", 0);
    if (align >= 1 && align <= 3) c.align = (["left", "center", "right"] as const)[align - 1];
    const fore = color(p.num("ForeColor", -1));
    if (fore && kind !== "line" && kind !== "rectangle") c.color = fore;
    const backStyle = p.num("BackStyle", kind === "label" || kind === "rectangle" || kind === "textbox" ? 0 : 1);
    const back = color(p.num("BackColor", -1));
    if (back && backStyle === 1 && kind !== "line") c.backColor = back;
    const border = color(p.num("BorderColor", -1));
    const style = p.has("BorderStyle") ? p.num("BorderStyle", 1) : p.num("OldBorderStyle", kind === "label" ? 0 : 1);
    if (kind === "line" || kind === "rectangle") {
      c.borderWidth = clamp(p.num("BorderWidth", 0) + 1, 1, 12);
      if (border) c.borderColor = border;
      if (style === 0 && kind === "rectangle") c.borderWidth = 0;
    } else if (style !== 0 && kind !== "label") {
      c.borderWidth = clamp(p.num("BorderWidth", 0) + 1, 1, 12);
      if (border) c.borderColor = border;
    }
    layout.controls.push(c);
  }
  // Sections hold their controls; the report is as wide as its widest control.
  for (const c of layout.controls) {
    const bottom = c.y + c.h;
    if (c.section.startsWith("g")) {
      const g = groups.find((x) => x.id === c.section.slice(3));
      if (g) {
        const which = c.section.startsWith("gh") ? "header" : "footer";
        if (bottom > g[which]) g[which] = clamp(bottom, 0, 2000);
      }
    } else {
      const k = c.section as keyof ReportLayout["sections"];
      if (bottom > layout.sections[k]) layout.sections[k] = clamp(bottom, 0, 4000);
    }
  }
  // As wide as its controls reach (Access's design width is often far wider than anything on it).
  const reach = layout.controls.reduce((m, c) => Math.max(m, c.x + c.w), 0);
  layout.width = clamp(reach || layout.width, 48, 4600);
  // A group section of no height with nothing in it and no page break isn't needed.
  for (const g of groups) {
    for (const which of ["header", "footer"] as const) {
      const k = `${which === "header" ? "gh" : "gf"}:${g.id}`;
      if (g[which] === 1 && !layout.controls.some((c) => c.section === k) && !sectionProps[k]) g[which] = 0;
    }
  }
  if (Object.keys(sectionProps).length) layout.sectionProps = sectionProps;
  if (skipped) out.warnings.push(`Report '${name}': ${skipped} control(s) (charts, subreports, OLE objects or pictures in the design) weren't imported.`);

  const detail = layout.controls.filter((c) => c.section === "detail" && c.field && !c.field.startsWith("=") && known.has(c.field.toLowerCase())).sort((a, b) => a.y - b.y || a.x - b.x);
  const report: ReportDef = {
    id: "",
    name: "",
    title: (props.str("Caption") ?? name).slice(0, 200),
    source: { kind: source.kind, id: source.id },
    columns: [...new Set(detail.map((c) => c.field!))].slice(0, 255),
    layout,
  };
  const firstGroup = groups.find((g) => g.header > 0 || g.footer > 0);
  if (firstGroup && known.has(firstGroup.field.toLowerCase())) report.groupBy = firstGroup.field;
  return report;
}
