/**
 * Macros, as in Access's Macro Builder: a list of steps, each an action with its arguments,
 * If / Else If / Else blocks, comments, groups and submacros. Buttons and other controls run
 * them from their events (On Click, After Update…), forms from theirs (On Load, On Current…),
 * and named macros appear in the Navigation Pane (AutoExec runs when the database opens).
 *
 * Arguments are kept as Access writes them: literal text ("Customers", "Next"), or an
 * expression starting with = ("=[Forms]![Orders]![ID]"). Conditions, Where Conditions and
 * SetTempVar / SetValue expressions are always expressions (without the =).
 */
import { z } from "zod";

export type MacroStep =
  | { kind: "action"; action: string; args?: Record<string, string> }
  | { kind: "if"; branches: { condition?: string; steps: MacroStep[] }[] }
  | { kind: "comment"; text: string }
  | { kind: "group"; name: string; steps: MacroStep[] }
  | { kind: "submacro"; name: string; steps: MacroStep[] };

export const macroStepSchema: z.ZodType<MacroStep> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("action"), action: z.string().min(1).max(64), args: z.record(z.string().max(64), z.string().max(8000)).optional() }),
    z.object({
      kind: z.literal("if"),
      branches: z.array(z.object({ condition: z.string().max(4000).optional(), steps: macroStepsSchema })).min(1).max(50),
    }),
    z.object({ kind: z.literal("comment"), text: z.string().max(4000) }),
    z.object({ kind: z.literal("group"), name: z.string().max(200), steps: macroStepsSchema }),
    z.object({ kind: z.literal("submacro"), name: z.string().min(1).max(64), steps: macroStepsSchema }),
  ]),
) as z.ZodType<MacroStep>;
export const macroStepsSchema: z.ZodType<MacroStep[]> = z.lazy(() => z.array(macroStepSchema).max(500));

/** Events of a control that can run a macro. */
export const CONTROL_EVENTS = ["onClick", "onDblClick", "afterUpdate", "onGotFocus", "onLostFocus"] as const;
export type ControlEvent = (typeof CONTROL_EVENTS)[number];
/** Events of a form that can run a macro. */
export const FORM_EVENTS = ["onLoad", "onCurrent", "onClose"] as const;
export type FormEvent = (typeof FORM_EVENTS)[number];
export const EVENT_LABELS: Record<ControlEvent | FormEvent, string> = {
  onClick: "On Click",
  onDblClick: "On Dbl Click",
  afterUpdate: "After Update",
  onGotFocus: "On Got Focus",
  onLostFocus: "On Lost Focus",
  onLoad: "On Load",
  onCurrent: "On Current",
  onClose: "On Close",
};

export const controlEventsSchema = z.object({ onClick: macroStepsSchema.optional(), onDblClick: macroStepsSchema.optional(), afterUpdate: macroStepsSchema.optional(), onGotFocus: macroStepsSchema.optional(), onLostFocus: macroStepsSchema.optional() });
export const formEventsSchema = z.object({ onLoad: macroStepsSchema.optional(), onCurrent: macroStepsSchema.optional(), onClose: macroStepsSchema.optional() });

export const macroSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  description: z.string().max(1000).optional(),
  steps: macroStepsSchema,
});
export type MacroDef = z.infer<typeof macroSchema>;

// ---------------------------------------------------------------- the actions

export type MacroArgKind =
  /** Literal text, or =expression. */
  | "text"
  /** Always an expression (no = needed). */
  | "expr"
  /** A Where Condition: an expression tested against each record of what's opened or filtered. */
  | "where"
  | "sql"
  | "choice"
  | "form"
  | "report"
  | "table"
  | "query"
  | "macro"
  | "control"
  | "object";

export interface MacroArgDef {
  name: string;
  label: string;
  kind: MacroArgKind;
  choices?: string[];
  /** Used when the argument is blank. */
  default?: string;
  required?: boolean;
  hint?: string;
}

export interface MacroActionDef {
  group: "Window" | "Records" | "Data" | "Filter/Query/Search" | "User Interface" | "Macro Commands" | "System";
  help: string;
  args: MacroArgDef[];
}

const OBJECT_TYPES = ["", "Table", "Query", "Form", "Report", "Macro"];
const YES_NO = ["Yes", "No"];

/** The actions this app runs, with the arguments the Macro Builder shows for each. */
export const MACRO_ACTIONS: Record<string, MacroActionDef> = {
  OpenForm: {
    group: "Window",
    help: "Opens a form, optionally showing only the records that match a Where Condition.",
    args: [
      { name: "FormName", label: "Form Name", kind: "form", required: true },
      { name: "View", label: "View", kind: "choice", choices: ["Form", "Design", "Datasheet"], default: "Form" },
      { name: "WhereCondition", label: "Where Condition", kind: "where", hint: "e.g. [CustomerID]=[Forms]![Orders]![CustomerID]" },
      { name: "DataMode", label: "Data Mode", kind: "choice", choices: ["", "Add", "Edit", "Read Only"] },
    ],
  },
  OpenReport: {
    group: "Window",
    help: "Opens a report, optionally only for the records that match a Where Condition.",
    args: [
      { name: "ReportName", label: "Report Name", kind: "report", required: true },
      { name: "View", label: "View", kind: "choice", choices: ["Report", "Print Preview", "Print", "Design"], default: "Report" },
      { name: "WhereCondition", label: "Where Condition", kind: "where" },
    ],
  },
  OpenTable: {
    group: "Window",
    help: "Opens a table in Datasheet or Design View.",
    args: [
      { name: "TableName", label: "Table Name", kind: "table", required: true },
      { name: "View", label: "View", kind: "choice", choices: ["Datasheet", "Design"], default: "Datasheet" },
    ],
  },
  OpenQuery: {
    group: "Window",
    help: "Opens a select query, or runs an action query.",
    args: [
      { name: "QueryName", label: "Query Name", kind: "query", required: true },
      { name: "View", label: "View", kind: "choice", choices: ["Datasheet", "Design", "SQL"], default: "Datasheet" },
    ],
  },
  CloseWindow: {
    group: "Window",
    help: "Closes the named object, or the form the macro runs in when none is named.",
    args: [
      { name: "ObjectType", label: "Object Type", kind: "choice", choices: OBJECT_TYPES },
      { name: "ObjectName", label: "Object Name", kind: "object" },
    ],
  },
  GoToRecord: {
    group: "Records",
    help: "Moves to the first, last, next or previous record, a record by number, or a new record.",
    args: [
      { name: "ObjectType", label: "Object Type", kind: "choice", choices: ["", "Form"] },
      { name: "ObjectName", label: "Object Name", kind: "form" },
      { name: "Record", label: "Record", kind: "choice", choices: ["Next", "Previous", "First", "Last", "Go To", "New"], default: "Next" },
      { name: "Offset", label: "Offset", kind: "text", hint: "How many records to move (or the record number for Go To)" },
    ],
  },
  GoToControl: {
    group: "Records",
    help: "Moves the focus to a control on the form.",
    args: [{ name: "ControlName", label: "Control Name", kind: "control", required: true }],
  },
  SaveRecord: { group: "Records", help: "Saves the record being edited.", args: [] },
  DeleteRecord: { group: "Records", help: "Deletes the current record (Access asks first).", args: [] },
  RefreshRecord: { group: "Records", help: "Shows the latest values of the form's records.", args: [] },
  Requery: {
    group: "Records",
    help: "Reads the form's records again (or a list box's / combo box's choices).",
    args: [{ name: "ControlName", label: "Control Name", kind: "control" }],
  },
  ApplyFilter: {
    group: "Filter/Query/Search",
    help: "Shows only the records that match a Where Condition.",
    args: [
      { name: "WhereCondition", label: "Where Condition", kind: "where", required: true },
      { name: "ControlName", label: "Control Name", kind: "control", hint: "A subform to filter instead (not supported here yet)" },
    ],
  },
  ShowAllRecords: { group: "Filter/Query/Search", help: "Removes the filter: shows every record.", args: [] },
  FindRecord: {
    group: "Filter/Query/Search",
    help: "Goes to the first record whose field contains the text.",
    args: [
      { name: "FindWhat", label: "Find What", kind: "text", required: true },
      { name: "Match", label: "Match", kind: "choice", choices: ["Whole Field", "Any Part of Field", "Start of Field"], default: "Whole Field" },
      { name: "OnlyCurrentField", label: "Only Current Field", kind: "choice", choices: ["Current", "All"], default: "All" },
    ],
  },
  RunSQL: {
    group: "Data",
    help: "Runs an action query's SQL: INSERT INTO, UPDATE, DELETE or SELECT … INTO.",
    args: [{ name: "SQLStatement", label: "SQL Statement", kind: "sql", required: true }],
  },
  SetValue: {
    group: "Data",
    help: "Sets a control's value (a field of the record, or an unbound control).",
    args: [
      { name: "Item", label: "Item", kind: "control", required: true, hint: "e.g. [Status] or [Forms]![Orders]![Status]" },
      { name: "Expression", label: "Expression", kind: "expr", required: true },
    ],
  },
  SetProperty: {
    group: "User Interface",
    help: "Changes a control's property while the form is open: Visible, Enabled, Locked, Caption, colors or Value.",
    args: [
      { name: "ControlName", label: "Control Name", kind: "control", required: true },
      { name: "Property", label: "Property", kind: "choice", choices: ["Enabled", "Visible", "Locked", "Value", "Caption", "ForeColor", "BackColor", "FontBold"], default: "Enabled" },
      { name: "Value", label: "Value", kind: "text", hint: "True / False, text, or =expression" },
    ],
  },
  MessageBox: {
    group: "User Interface",
    help: "Shows a message.",
    args: [
      { name: "Message", label: "Message", kind: "text", required: true },
      { name: "Beep", label: "Beep", kind: "choice", choices: YES_NO, default: "Yes" },
      { name: "Type", label: "Type", kind: "choice", choices: ["None", "Critical", "Warning?", "Warning!", "Information"], default: "None" },
      { name: "Title", label: "Title", kind: "text" },
    ],
  },
  Beep: { group: "User Interface", help: "Sounds a beep.", args: [] },
  SetWarnings: {
    group: "System",
    help: "No: RunSQL and action queries run without asking first, until the macro ends or warnings are turned on again.",
    args: [{ name: "WarningsOn", label: "Warnings On", kind: "choice", choices: YES_NO, default: "No" }],
  },
  SetTempVar: {
    group: "Macro Commands",
    help: "Stores a value in a temporary variable, read anywhere as [TempVars]![Name] while the database is open.",
    args: [
      { name: "Name", label: "Name", kind: "text", required: true },
      { name: "Expression", label: "Expression", kind: "expr", required: true },
    ],
  },
  RemoveTempVar: { group: "Macro Commands", help: "Removes a temporary variable.", args: [{ name: "Name", label: "Name", kind: "text", required: true }] },
  RemoveAllTempVars: { group: "Macro Commands", help: "Removes all temporary variables.", args: [] },
  SetLocalVar: {
    group: "Macro Commands",
    help: "Stores a value read as [LocalVars]![Name] until this macro ends.",
    args: [
      { name: "Name", label: "Name", kind: "text", required: true },
      { name: "Expression", label: "Expression", kind: "expr", required: true },
    ],
  },
  RunMacro: {
    group: "Macro Commands",
    help: "Runs a named macro (or one of its submacros: Macro.Submacro), optionally several times.",
    args: [
      { name: "MacroName", label: "Macro Name", kind: "macro", required: true },
      { name: "RepeatCount", label: "Repeat Count", kind: "text" },
      { name: "RepeatExpression", label: "Repeat Expression", kind: "expr" },
    ],
  },
  RunMenuCommand: {
    group: "Macro Commands",
    help: "Runs one of Access's commands.",
    args: [
      {
        name: "Command",
        label: "Command",
        kind: "choice",
        choices: ["SaveRecord", "DeleteRecord", "RecordsGoToNew", "Undo", "Refresh", "RemoveFilterSort", "Find", "PrintObject", "Close"],
        required: true,
      },
    ],
  },
  OnError: {
    group: "Macro Commands",
    help: "What to do when an action fails: stop with a message (Fail), carry on (Next), or run a submacro (Macro Name).",
    args: [
      { name: "Goto", label: "Go to", kind: "choice", choices: ["Next", "Macro Name", "Fail"], default: "Fail" },
      { name: "MacroName", label: "Macro Name", kind: "text" },
    ],
  },
  ClearMacroError: { group: "Macro Commands", help: "Clears [MacroError].", args: [] },
  StopMacro: { group: "Macro Commands", help: "Stops this macro.", args: [] },
  StopAllMacros: { group: "Macro Commands", help: "Stops all running macros.", args: [] },
  CancelEvent: { group: "Macro Commands", help: "Cancels the event that ran the macro (where the event can be cancelled).", args: [] },
  PrintOut: { group: "System", help: "Prints the open report or form.", args: [] },
  QuitAccess: { group: "System", help: "Closes every open object.", args: [] },
  Echo: { group: "System", help: "Has no effect here (screen updates are instant).", args: [] },
  DisplayHourglassPointer: { group: "System", help: "Has no effect here.", args: [] },
};

/** Old (Access 2007 and earlier) and VBA names for the same actions. */
export const MACRO_ACTION_ALIASES: Record<string, string> = {
  msgbox: "MessageBox",
  close: "CloseWindow",
  runcommand: "RunMenuCommand",
  hourglass: "DisplayHourglassPointer",
  quit: "QuitAccess",
  showallrecords: "ShowAllRecords",
  refresh: "RefreshRecord",
};

export function canonicalAction(name: string): string {
  const k = name.toLowerCase();
  const known = Object.keys(MACRO_ACTIONS).find((a) => a.toLowerCase() === k);
  return known ?? MACRO_ACTION_ALIASES[k] ?? name;
}

/** Every action step in a macro, at any depth. */
export function macroActions(steps: readonly MacroStep[]): Extract<MacroStep, { kind: "action" }>[] {
  const out: Extract<MacroStep, { kind: "action" }>[] = [];
  const walk = (list: readonly MacroStep[]) => {
    for (const s of list) {
      if (s.kind === "action") out.push(s);
      else if (s.kind === "if") s.branches.forEach((b) => walk(b.steps));
      else if (s.kind === "group" || s.kind === "submacro") walk(s.steps);
    }
  };
  walk(steps);
  return out;
}

/** One line per step, as the Macro Builder shows it collapsed (tooltips, summaries, tests). */
export function macroSummary(steps: readonly MacroStep[], indent = ""): string[] {
  const out: string[] = [];
  for (const s of steps) {
    switch (s.kind) {
      case "action": {
        const args = Object.entries(s.args ?? {}).filter(([, v]) => v !== "");
        out.push(`${indent}${s.action}${args.length ? " " + args.map(([k, v]) => `${k}: ${v}`).join(", ") : ""}`);
        break;
      }
      case "comment":
        out.push(`${indent}/* ${s.text} */`);
        break;
      case "if":
        s.branches.forEach((b, i) => {
          out.push(`${indent}${i === 0 ? "If" : b.condition === undefined ? "Else" : "Else If"}${b.condition !== undefined ? ` ${b.condition} Then` : ""}`);
          out.push(...macroSummary(b.steps, indent + "  "));
        });
        out.push(`${indent}End If`);
        break;
      case "group":
        out.push(`${indent}Group: ${s.name}`, ...macroSummary(s.steps, indent + "  "), `${indent}End Group`);
        break;
      case "submacro":
        out.push(`${indent}Submacro: ${s.name}`, ...macroSummary(s.steps, indent + "  "), `${indent}End Submacro`);
        break;
    }
  }
  return out;
}
