import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buttonAction, importFormsAndReports, readGroupLevels } from "../src/accessForms.js";
import type { ProjectDoc } from "../../shared/model.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("importing Access forms", () => {
  it("converts forms: layout in pixels, sections, labels, calculated boxes, SQL record sources as queries", () => {
    const file = fs.readFileSync(path.join(here, "fixtures/formPropTest.accdb"));
    const doc: ProjectDoc = {
      version: 1,
      tables: [{ id: "t1", name: "Table1", fields: [{ id: "f1", name: "ID", type: "AutoNumber", primaryKey: true }, { id: "f2", name: "ProductName", type: "ShortText" }, { id: "f3", name: "Price", type: "Currency" }, { id: "f4", name: "Qty", type: "Number" }], rows: [] }],
      queries: [],
      forms: [],
      reports: [],
      relationships: [],
    } as unknown as ProjectDoc;
    const out = importFormsAndReports(file, doc);
    expect(out.forms.map((f) => f.name).sort()).toEqual(["F_Buttons", "F_Table0", "F_Table1", "jp_フォーム_2"]);

    const f = out.forms.find((x) => x.name === "F_Table1")!;
    // Its record source was a SQL statement: saved as a query, as Access does behind the scenes.
    expect(f.source?.kind).toBe("query");
    expect(out.queries.find((q) => q.id === f.source?.id)?.sql).toMatch(/^SELECT/i);
    const c = (name: string) => f.layout!.controls.find((x) => x.name === name)!;
    expect(c("ProductName")).toMatchObject({ type: "textbox", field: "ProductName", section: "detail", labelPos: "none" });
    expect(c("Text_01_SubTotal").field).toBe("=[Price]*[Qty]");
    // Twips to pixels (÷15); Access's labels are their own controls.
    expect(c("ProductName").x).toBeGreaterThan(c("ラベル3").x);
    expect(f.layout!.controls.some((x) => x.type === "label" && x.section === "header")).toBe(true);
    expect(f.layout!.sections.header).toBeGreaterThan(0);
    expect(f.layout!.tabOrder?.length).toBeGreaterThan(3);

    // Unbound forms (menus, dialogs) come across without a record source and without a navigation bar.
    const b = out.forms.find((x) => x.name === "F_Buttons")!;
    expect(b.source).toBeUndefined();
    expect(b.layout!.navigationButtons).toBe(false);
    expect(b.layout!.controls.every((x) => x.type === "button" && x.action === "none")).toBe(true);
    expect(out.warnings.join(" ")).toMatch(/F_Buttons' has code for events this app doesn't run yet \(On GotFocus/);
  });

  it("reads common button actions from VBA and macros", () => {
    expect(buttonAction('Dim stDocName As String\n stDocName = "Customers"\n DoCmd.OpenForm stDocName, , , stLinkCriteria')).toEqual({ action: "openForm", target: { kind: "form", name: "Customers" } });
    expect(buttonAction('DoCmd.OpenReport "Sales", acViewPreview')).toEqual({ action: "openReport", target: { kind: "report", name: "Sales" } });
    expect(buttonAction("DoCmd.GoToRecord , , acNewRec")?.action).toBe("newRecord");
    expect(buttonAction("DoCmd.GoToRecord , , acNext")?.action).toBe("nextRecord");
    expect(buttonAction("DoCmd.RunCommand acCmdSaveRecord")?.action).toBe("saveRecord");
    expect(buttonAction("DoCmd.DoMenuItem acFormBar, acEditMenu, acDelete, , acMenuVer70")?.action).toBe("deleteRecord");
    expect(buttonAction("DoCmd.Close")?.action).toBe("closeForm");
    expect(buttonAction('MsgBox "Hello"')).toBeNull();
  });

  it("reads a report's group levels (Sorting and Grouping) from its design", () => {
    // Header, the report's own properties, then two group levels: H_Name with a header, Surname without.
    const prop = (id: number, value: Buffer, trailer: number) => {
      const b = Buffer.alloc(18 + value.length);
      b.writeUInt16LE(id, 0);
      b.writeUInt32LE(value.length, 10);
      value.copy(b, 14);
      b.writeUInt32LE(trailer, 14 + value.length);
      return b;
    };
    const node = (type: number, ...props: Buffer[]) => Buffer.concat([Buffer.from([type & 0xff, type >> 8, 0, 0, 0, 0]), ...props]);
    const text = (s: string) => Buffer.from(s, "utf16le");
    const blob = Buffer.concat([
      Buffer.from([0x14, 0, 0x14, 0, 0, 0, 0, 0, 0x97, 0, 0, 0, 0, 0]),
      prop(0x9c, text("Owners"), 255),
      Buffer.from([2, 0]),
      node(0x9f, prop(175, Buffer.alloc(0), 1), prop(27, text("H_Name"), 253)),
      node(0x9f, prop(27, text("[Surname]"), 253)),
    ]);
    expect(readGroupLevels(blob)).toEqual([
      { field: "H_Name", header: true },
      { field: "Surname", header: false },
    ]);
    expect(readGroupLevels(Buffer.from([0x13, 0, 0]))).toEqual([]);
  });
});
