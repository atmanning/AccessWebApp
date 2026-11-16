import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { macroStepsSchema, macroSummary } from "../../shared/macros.js";
import { importFormsAndReports, simpleButtonAction } from "../src/accessForms.js";
import { jetStatementsToSteps, vbaExpr, vbaProcedure, vbaToSteps } from "../src/accessMacros.js";

const summary = (body: string, names?: string[]) => {
  const r = vbaToSteps(body, { names: names ? new Set(names.map((n) => n.toLowerCase())) : undefined });
  expect(macroStepsSchema.safeParse(r.steps).success).toBe(true);
  return { lines: macroSummary(r.steps), unconverted: r.unconverted };
};

describe("importing macros", () => {
  it("reads named and embedded macros from an Access file", () => {
    const doc = { version: 1, tables: [], queries: [], forms: [], reports: [], relationships: [] } as never;
    const out = importFormsAndReports(readFileSync(new URL("./fixtures/macroTestV2010.accdb", import.meta.url)), doc);
    expect(out.macros.map((m) => m.name)).toEqual(["AutoExec", "mcrConditions", "mcrLongText", "mcrSimple"]);
    const cond = out.macros.find((m) => m.name === "mcrConditions")!;
    expect(macroSummary(cond.steps)).toEqual([
      "/* first comment */",
      "If [TempVars]![x]=1 Then",
      "  MessageBox Message: one",
      "Else If [TempVars]![x]<10 Then",
      "  MessageBox Message: small",
      "Else",
      "  MessageBox Message: other",
      "End If",
      "StopMacro",
    ]);
    const simple = out.macros.find((m) => m.name === "mcrSimple")!;
    expect(simple.steps[1]).toEqual({ kind: "action", action: "MessageBox", args: { Message: "Hello", Beep: "No", Type: "Information", Title: "Title" } });
    const btn = out.forms[0].layout!.controls.find((c) => c.name === "btnHello")!;
    expect(btn.events?.onClick).toEqual([{ kind: "action", action: "MessageBox", args: { Message: "button clicked" } }]);
    expect(out.warnings.join(" ")).toMatch(/doesn't run yet \(BeforeUpdate\)/);
  });

  it("keeps groups, submacros and old action names", () => {
    const steps = jetStatementsToSteps([
      { kind: "group", description: "Group A", statements: [{ kind: "action", name: "MsgBox", arguments: [{ name: "Message", value: "x" }] }] },
      { kind: "submacro", name: "Sub1", statements: [{ kind: "action", name: "Close", arguments: [] }] },
      { kind: "weird" },
    ]);
    expect(macroSummary(steps)).toEqual(["Group: Group A", "  MessageBox Message: x", "End Group", "Submacro: Sub1", "  CloseWindow", "End Submacro", "/* Not imported: a weird element of the Access macro. */"]);
  });
});

describe("VBA event procedures as macros", () => {
  const module = `Option Compare Database

Private Sub cmdNext_Click()
On Error GoTo Err_cmdNext_Click
    DoCmd.GoToRecord , , acNext
Exit_cmdNext_Click:
    Exit Sub
Err_cmdNext_Click:
    MsgBox Err.Description
    Resume Exit_cmdNext_Click
End Sub

Private Sub Refresh_Totals()
    Me.Requery
End Sub
`;
  it("finds a procedure, and stops at the wizard's error-handling labels", () => {
    const body = vbaProcedure(module, "cmdNext_Click")!;
    expect(summary(body).lines).toEqual(["GoToRecord Record: Next"]);
    expect(vbaProcedure(module, "Nope_Click")).toBeNull();
  });

  it("converts DoCmd calls with positional and named arguments and ac constants", () => {
    const r = summary(`
      Dim stLinkCriteria As String
      stLinkCriteria = "[CustomerID]=" & Me![CustomerID]
      DoCmd.OpenForm "Orders", , , stLinkCriteria, acFormEdit
      DoCmd.OpenReport ReportName:="Invoice", View:=acViewPreview, WhereCondition:="[OrderID]=" & Me.OrderID
      DoCmd.Close acForm, Me.Name
      DoCmd.Close
      DoCmd.SetWarnings False
      DoCmd.RunSQL "UPDATE Orders SET Shipped = True WHERE OrderID = " & Me.OrderID
      DoCmd.SetWarnings True
      DoCmd.RunCommand acCmdSaveRecord
      DoCmd.GoToRecord , , acNewRec
      DoCmd.Hourglass True
      Call DoCmd.OpenQuery("Monthly Totals")
    `);
    expect(r.lines).toEqual([
      'SetLocalVar Name: stLinkCriteria, Expression: "[CustomerID]=" & [CustomerID]',
      "OpenForm FormName: Orders, WhereCondition: =[LocalVars]![stLinkCriteria], DataMode: Edit",
      'OpenReport ReportName: Invoice, View: Print Preview, WhereCondition: ="[OrderID]=" & [OrderID]',
      "/* VBA not converted (Me.Name isn't available in macros.): DoCmd.Close acForm, Me.Name */",
      "CloseWindow",
      "SetWarnings WarningsOn: No",
      'RunSQL SQLStatement: ="UPDATE Orders SET Shipped = True WHERE OrderID = " & [OrderID]',
      "SetWarnings WarningsOn: Yes",
      "RunMenuCommand Command: SaveRecord",
      "GoToRecord Record: New",
      "OpenQuery QueryName: Monthly Totals",
    ]);
    expect(r.unconverted).toHaveLength(1);
  });

  it("converts If blocks, MsgBox, control properties, values, TempVars and domain functions", () => {
    const r = summary(
      `
      If IsNull(Me.CustomerID) Then
          MsgBox "Pick a customer first.", vbExclamation, "Orders"
          Me.CustomerID.SetFocus
          Exit Sub
      ElseIf DCount("*", "Orders", "CustomerID=" & Me.CustomerID) > 10 Then
          Me.lblVip.Visible = True
          Me!Discount = Nz(DLookup("Rate", "Discounts", "Level='VIP'"), 0) ' a comment
      Else
          Me.lblVip.Visible = False
      End If
      If MsgBox("Delete this order?", vbYesNo + vbQuestion) = vbYes Then DoCmd.RunCommand acCmdDeleteRecord
      TempVars("LastCustomer") = Me.CustomerID
      TempVars.Add "User", Forms!Login!UserName
      gCount = gCount + 1
      Forms!Main!Status = "Saved " & Date
      Me.Requery
      Me.Filter = "[City]='" & Me.txtCity & "'"
      Me.FilterOn = True
    `,
      ["CustomerID", "lblVip", "Discount", "txtCity", "City"],
    );
    expect(r.lines).toEqual([
      "If IsNull([CustomerID]) Then",
      "  MessageBox Message: Pick a customer first., Type: Warning!, Title: Orders",
      "  GoToControl ControlName: CustomerID",
      "  StopMacro",
      'Else If DCount("*", "Orders", "CustomerID=" & [CustomerID]) > 10 Then',
      "  SetProperty ControlName: lblVip, Property: Visible, Value: =True",
      '  SetValue Item: [Discount], Expression: Nz(DLookup("Rate", "Discounts", "Level=\'VIP\'"), 0)',
      "Else",
      "  SetProperty ControlName: lblVip, Property: Visible, Value: =False",
      "End If",
      'If MsgBox("Delete this order?", 4 + 32) = 6 Then',
      "  RunMenuCommand Command: DeleteRecord",
      "End If",
      "SetTempVar Name: LastCustomer, Expression: [CustomerID]",
      "SetTempVar Name: User, Expression: [Forms]![Login]![UserName]",
      "SetTempVar Name: gCount, Expression: [TempVars]![gCount] + 1",
      'SetValue Item: [Forms]![Main]![Status], Expression: "Saved " & Date()',
      "Requery",
      "ApplyFilter WhereCondition: =\"[City]='\" & [txtCity] & \"'\"",
    ]);
    expect(r.unconverted).toEqual([]);
  });

  it("keeps what it can't convert as comments, and never runs an unconverted If's steps unchecked", () => {
    const r = summary(`
      Set rs = CurrentDb.OpenRecordset("Orders")
      If rs.EOF Then
        DoCmd.RunSQL "DELETE FROM Orders"
      End If
      For i = 1 To 10
        Beep
      Next i
      Me.Requery
    `);
    expect(r.lines[0]).toMatch(/^\/\* VBA not converted: Set rs/);
    expect(r.lines[1]).toMatch(/^If NotConvertedFromVBA\(/);
    expect(r.lines.slice(2)).toEqual(["  RunSQL SQLStatement: DELETE FROM Orders", "End If", "/* VBA not converted (loops and Select Case): For i = 1 To 10 … */", "Requery"]);
    expect(r.unconverted).toHaveLength(3);
  });

  it("puts other procedures of the module in place", () => {
    const r = vbaToSteps("Refresh_Totals\nBeep", { module });
    expect(macroSummary(r.steps)).toEqual(["Group: Refresh_Totals (from VBA)", "  Requery", "End Group", "Beep"]);
  });

  it("translates expressions", () => {
    expect(vbaExpr('Me.FirstName & " " & Me!LastName')).toBe('[FirstName] & " " & [LastName]');
    expect(vbaExpr('Forms("Orders").Controls("Total").Value * 2')).toBe("[Forms]![Orders]![Total] * 2");
    expect(vbaExpr("Now - 1 <> vbNullString")).toBe('Now() - 1 <> ""');
    expect(() => vbaExpr("rs!Total")).toThrow();
  });

  it("uses the built-in button actions for plain buttons", () => {
    expect(simpleButtonAction([{ kind: "action", action: "GoToRecord", args: { Record: "Next" } }])).toEqual({ action: "nextRecord" });
    expect(simpleButtonAction([{ kind: "action", action: "OpenForm", args: { FormName: "Orders" } }])).toEqual({ action: "openForm", target: { kind: "form", name: "Orders" } });
    expect(simpleButtonAction([{ kind: "action", action: "OpenForm", args: { FormName: "Orders", WhereCondition: "[ID]=1" } }])).toBeNull();
    expect(simpleButtonAction([{ kind: "action", action: "Beep" }, { kind: "action", action: "CloseWindow" }])).toBeNull();
  });
});
