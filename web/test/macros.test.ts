import { describe, expect, it } from "vitest";
import { macroStepsSchema, macroSummary, type MacroStep } from "../../shared/macros";
import { projectDocSchema } from "../../shared/model";
import { compileExpression, evaluate, rowContext } from "../src/engine/expr";
import { makeFormCalc } from "../src/forms/formCalc";
import { freezeReferences, runMacro, type MacroEnv } from "../src/macros/runMacro";
import { registerForm, tempVars, type FormHandle } from "../src/macros/runtime";

const doc = {
  version: 1,
  tables: [
    {
      id: "t1",
      name: "Customers",
      fields: [{ id: "f1", name: "ID", type: "Number" }, { id: "f2", name: "Name", type: "ShortText" }, { id: "f3", name: "Balance", type: "Currency" }],
      rows: [{ _id: 1, f1: 1, f2: "Ada", f3: 10 }, { _id: 2, f1: 2, f2: "Alan", f3: 0 }],
    },
  ],
  queries: [],
  forms: [{ id: "fm1", name: "Customers", title: "Customers", source: { kind: "table", id: "t1" }, columns: [] }],
  reports: [{ id: "r1", name: "Balances", title: "Balances", source: { kind: "table", id: "t1" }, columns: [] }],
  relationships: [],
  macros: [
    {
      id: "m1",
      name: "Lib",
      steps: [
        { kind: "action", action: "SetTempVar", args: { Name: "fromLib", Expression: "1" } },
        { kind: "submacro", name: "Hello", steps: [{ kind: "action", action: "SetTempVar", args: { Name: "hello", Expression: '"hi"' } }] },
      ],
    },
  ],
} as never;

function fakeForm(values: Record<string, unknown>): FormHandle & { log: string[] } {
  const log: string[] = [];
  const calc = makeFormCalc(doc, { controls: [] }, Object.keys(values));
  return {
    log,
    formId: "fm1",
    name: "Customers",
    tabKey: "form:fm1",
    value: (n) => (n in values ? (values[n] as never) : undefined),
    evaluate: (e) => calc.evaluate(e, Object.values(values) as never, () => []),
    goToRecord: (r, o) => void log.push(`goto ${r} ${o}`),
    goToControl: (n) => (log.push(`focus ${n}`), true),
    newRecord: () => void log.push("new"),
    saveRecord: () => void log.push("save"),
    deleteRecord: async () => void log.push("delete"),
    undo: () => {},
    requery: () => void log.push("requery"),
    applyFilter: (w) => void log.push(`filter ${w}`),
    findRecord: () => true,
    setValue: (n, v) => (log.push(`set ${n}=${v}`), null),
    setProperty: (n, p, v) => (log.push(`prop ${n}.${p}=${v}`), null),
    close: () => void log.push("close"),
  };
}

function env(form?: FormHandle) {
  const log: string[] = [];
  const e: MacroEnv & { log: string[] } = {
    log,
    form,
    evaluate: (x) => (form ? form.evaluate(x) : makeFormCalc(doc, { controls: [] }, []).evaluate(x, null, () => [])),
    doc: () => doc,
    open: (kind, id, view, opts) => void log.push(`open ${kind} ${id}${view ? " " + view : ""}${opts.where ? ` where ${opts.where}` : ""}${opts.dataMode ? ` mode ${opts.dataMode}` : ""}`),
    close: (kind, id) => void log.push(`close ${kind} ${id}`),
    closeAll: () => void log.push("closeAll"),
    runSql: async (sql, warnings) => void log.push(`sql ${warnings ? "ask" : "quiet"} ${sql}`),
    runActionQuery: async () => false,
    message: async (t, title) => void log.push(`msg ${title ? title + ": " : ""}${t}`),
    ask: async (t, _title, buttons) => (log.push(`ask ${buttons} ${t}`), 6),
    status: (t) => void log.push(`status ${t}`),
    beep: () => {},
    print: () => void log.push("print"),
  };
  return e;
}

const act = (action: string, args: Record<string, string> = {}): MacroStep => ({ kind: "action", action, args });

describe("macros", () => {
  it("runs the core DoCmd actions with arguments worked out from the form", async () => {
    const f = fakeForm({ ID: 7, Name: "Ada" });
    // [Forms]![Customers]![ID] reads the open form.
    const un = registerForm(f);
    const e2 = env(f);
    const r2 = await runMacro(
      [
        act("OpenForm", { FormName: "Customers", WhereCondition: "[ID]=[Forms]![Customers]![ID]", DataMode: "Read Only" }),
        act("OpenReport", { ReportName: "Balances", View: "Print Preview", WhereCondition: '="[ID]=" & [ID]' }),
        act("GoToRecord", { Record: "Next" }),
        act("GoToRecord", { Record: "Go To", Offset: "=1+2" }),
        act("SetWarnings", { WarningsOn: "No" }),
        act("RunSQL", { SQLStatement: "UPDATE Customers SET Balance = 0 WHERE ID = [Forms]![Customers]![ID]" }),
        act("SetWarnings", { WarningsOn: "Yes" }),
        act("RunSQL", { SQLStatement: '="DELETE FROM Customers WHERE Name = \'" & [Name] & "\'"' }),
        act("MessageBox", { Message: '="Hello " & [Name]', Title: "Greeting" }),
        act("RunMenuCommand", { Command: "SaveRecord" }),
        act("CloseWindow"),
      ],
      e2,
    );
    un();
    expect(r2).toMatchObject({ ok: true });
    expect(e2.log).toEqual([
      "open form fm1 where [ID]=7 mode Read Only",
      "open report r1 where [ID]=7",
      "sql quiet UPDATE Customers SET Balance = 0 WHERE ID = 7",
      "sql ask DELETE FROM Customers WHERE Name = 'Ada'",
      "msg Greeting: Hello Ada",
    ]);
    expect(f.log).toEqual(["goto Next 1", "goto Go To 3", "save", "close"]);
  });

  it("follows If / Else If / Else, temporary variables and submacros", async () => {
    tempVars.clear();
    const e = env(fakeForm({ Balance: 0 }));
    const steps: MacroStep[] = [
      { kind: "comment", text: "a note" },
      act("SetTempVar", { Name: "Count", Expression: "5" }),
      {
        kind: "if",
        branches: [
          { condition: "[Balance] > 0", steps: [act("MessageBox", { Message: "owes" })] },
          { condition: "[TempVars]![Count] > 3", steps: [act("MessageBox", { Message: '="many: " & [TempVars]![Count]' })] },
          { steps: [act("MessageBox", { Message: "else" })] },
        ],
      },
      act("RunMacro", { MacroName: "Lib.Hello" }),
      act("RunMacro", { MacroName: "Lib" }),
      act("StopMacro"),
      act("MessageBox", { Message: "never" }),
    ];
    const r = await runMacro(steps, e);
    expect(r.ok).toBe(true);
    expect(e.log).toEqual(["msg many: 5"]);
    expect(tempVars.get("hello")).toBe("hi");
    expect(tempVars.get("fromlib")).toBe(1);
    // Expressions anywhere read temporary variables.
    const c = compileExpression("[TempVars]![Count] * 2");
    expect(c.ok && evaluate(c.node, rowContext([], null))).toBe(10);
  });

  it("stops with a message when an action fails, unless OnError says otherwise", async () => {
    const e = env();
    const r = await runMacro([act("OpenForm", { FormName: "Nope" }), act("MessageBox", { Message: "after" })], e);
    expect(r.ok).toBe(false);
    expect(e.log).toEqual(["msg Action Failed: OpenForm failed: There's no form named 'Nope'."]);
    const e2 = env();
    const r2 = await runMacro([act("OnError", { Goto: "Next" }), act("GoToRecord", { Record: "Next" }), act("MessageBox", { Message: "=[MacroError].[Description]" })], e2);
    expect(r2.ok).toBe(true);
    expect(e2.log[0]).toMatch(/^msg There's no form to act on/);
    const e3 = env();
    await runMacro([act("OnError", { Goto: "Macro Name", MacroName: "Oops" }), act("RunCode", { FunctionName: "X()" }), act("Beep"), { kind: "submacro", name: "Oops", steps: [act("MessageBox", { Message: "handled" })] }], e3);
    expect(e3.log).toEqual(["msg handled"]);
  });

  it("freezes references to forms and variables in Where Conditions and SQL", () => {
    const vals: Record<string, unknown> = { "[Forms]![Orders]![ID]": 12, "Forms!Orders!Customer": "O'Brien \"Jr\"", "[TempVars]![x]": null };
    const out = freezeReferences("[ID]=[Forms]![Orders]![ID] AND [Name]=Forms!Orders!Customer OR [X]=[TempVars]![x] AND [Forms]![Gone]![Y]=1", (r) => {
      if (r in vals) return vals[r] as never;
      throw new Error("not open");
    });
    expect(out).toBe('[ID]=12 AND [Name]="O\'Brien ""Jr""" OR [X]=Null AND [Forms]![Gone]![Y]=1');
  });

  it("is valid in the document schema, and summarizes for tooltips", () => {
    const steps: MacroStep[] = [act("OpenForm", { FormName: "Customers" }), { kind: "if", branches: [{ condition: "1=1", steps: [act("Beep")] }, { steps: [] }] }];
    expect(macroStepsSchema.safeParse(steps).success).toBe(true);
    expect(macroSummary(steps)).toEqual(["OpenForm FormName: Customers", "If 1=1 Then", "  Beep", "Else", "End If"]);
    const d = JSON.parse(JSON.stringify(doc));
    d.forms[0].events = { onLoad: steps };
    d.tables[0].rows = [];
    d.tables[0].nextAutoNumber = 1;
    const parsed = projectDocSchema.safeParse(d);
    expect(parsed.error?.issues ?? []).toEqual([]);
  });
});
