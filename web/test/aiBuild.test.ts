/** The AI assistant's designs become ordinary tables, relationships, lookups, forms, queries and reports. */
import { describe, expect, it, vi } from "vitest";

vi.mock("sql.js/dist/sql-wasm.wasm?url", async () => {
  const { createRequire } = await import("node:module");
  return { default: createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm") };
});

import { aiDatabaseSpec } from "../../shared/ai";
import { emptyProject } from "../../shared/model";
import { buildTemplate } from "../../shared/templates";
import { buildDatabase } from "../src/ai/buildDatabase";
import { schemaForAi } from "../src/ai/schemaForAi";
import { runQuery } from "../src/engine/engine";

const design = aiDatabaseSpec.parse({
  name: "Volunteers",
  summary: "Volunteers, events and the hours they work.",
  tables: [
    {
      name: "Volunteers",
      fields: [
        { name: "VolunteerID", type: "AutoNumber" },
        { name: "FullName", type: "ShortText", size: 80, required: true },
        { name: "Status", type: "ShortText", choices: ["Active", "Inactive"] },
      ],
      sampleRows: [
        { FullName: "Ann Lee", Status: "Active" },
        { FullName: "Bob Stone", Status: "Inactive" },
      ],
    },
    {
      name: "Shifts",
      fields: [
        { name: "ShiftID", type: "AutoNumber" },
        { name: "VolunteerID", type: "Number", references: "Volunteers" },
        { name: "ShiftDate", type: "DateTime" },
        { name: "Hours", type: "Number" },
        { name: "Paid", type: "YesNo" },
      ],
      sampleRows: [
        { VolunteerID: 1, ShiftDate: "2026-11-02", Hours: 3, Paid: "No" },
        { VolunteerID: 1, ShiftDate: "11/09/2026", Hours: "4.5", Paid: false },
        { VolunteerID: 9, ShiftDate: "2026-11-10", Hours: 2 },
      ],
    },
  ],
  queries: [{ name: "Hours by Volunteer", sql: "SELECT [Volunteers].[FullName], Sum([Shifts].[Hours]) AS [Total Hours]\nFROM [Volunteers] INNER JOIN [Shifts] ON [Volunteers].[VolunteerID] = [Shifts].[VolunteerID]\nGROUP BY [Volunteers].[FullName];", explanation: "Total hours." }],
  reports: [{ name: "Shift List", source: "Shifts", columns: ["ShiftDate", "hours", "Nope"], groupBy: "VolunteerID" }, { name: "Ghost", source: "Nothing", columns: ["X"] }],
});

describe("buildDatabase", () => {
  it("makes keyed tables, a relationship with a drop-down, value lists, sample records, forms, queries and reports", async () => {
    const doc = emptyProject();
    const r = buildDatabase(doc, design, { sampleData: true });
    expect(r.tables.map((t) => t.name)).toEqual(["Volunteers", "Shifts"]);
    const [vol, shifts] = doc.tables;
    expect(vol.fields[0]).toMatchObject({ name: "VolunteerID", type: "AutoNumber", primaryKey: true });
    expect(vol.fields[2].lookup).toMatchObject({ rowSourceType: "values", rowSource: "Active;Inactive" });
    const fk = shifts.fields[1];
    expect(fk.lookup).toMatchObject({ rowSourceType: "table", rowSource: vol.id, boundColumn: "VolunteerID", displayColumn: "FullName" });
    expect(doc.relationships).toEqual([expect.objectContaining({ fromTable: vol.id, toTable: shifts.id, toField: fk.id, enforce: true })]);
    // Keys count from 1; values are converted; a reference to a record that isn't there is left blank.
    expect(vol.rows.map((x) => x[vol.fields[0].id])).toEqual([1, 2]);
    expect(vol.nextAutoNumber).toBe(3);
    expect(shifts.rows[1][shifts.fields[2].id]).toBe("2026-11-09");
    expect(shifts.rows[1][shifts.fields[3].id]).toBe(4.5);
    expect(shifts.rows[0][shifts.fields[4].id]).toBe(false);
    expect(shifts.rows[2][fk.id]).toBeNull();
    expect(doc.forms.map((f) => f.name)).toEqual(["Volunteers", "Shifts"]);
    expect(doc.forms[0].layout?.controls.length).toBeGreaterThan(2);
    expect(doc.queries[0]).toMatchObject({ name: "Hours by Volunteer", mode: "design" });
    const res = await runQuery(doc, doc.queries[0].sql);
    expect(res.rows).toEqual([["Ann Lee", 7.5]]);
    expect(doc.reports).toEqual([expect.objectContaining({ name: "Shift List", columns: ["ShiftDate", "Hours"], groupBy: "VolunteerID" })]);
    expect(r.notes.join(" ")).toMatch(/Ghost/);
  });

  it("adds to a database without clashing, using a table it already has", () => {
    const doc = buildTemplate("contacts");
    const before = doc.tables.length;
    const spec = aiDatabaseSpec.parse({
      name: "x",
      summary: "x",
      tables: [
        { name: "Customers", fields: [{ name: "CustomerID", type: "AutoNumber" }] },
        { name: "Complaints", fields: [{ name: "ComplaintID", type: "AutoNumber" }, { name: "CustomerID", type: "Number", references: "Customers" }, { name: "Details", type: "LongText" }] },
      ],
      queries: [{ name: "Active Customers", sql: "SELECT * FROM [Complaints];", explanation: "x" }],
    });
    const r = buildDatabase(doc, spec, { adding: true });
    expect(doc.tables.length).toBe(before + 1);
    expect(r.notes[0]).toMatch(/already in this database/);
    const complaints = doc.tables.at(-1)!;
    expect(complaints.fields[1].lookup?.rowSource).toBe(doc.tables.find((t) => t.name === "Customers")!.id);
    expect(r.queries[0].name).toBe("Active Customers1");
    expect(complaints.rows).toEqual([]);
  });

  it("describes a database's design for the assistant, with short lists' values but no other records", () => {
    const doc = buildTemplate("contacts");
    const text = schemaForAi(doc);
    expect(text).toContain("Table [Customers]");
    expect(text).toContain("[CustomerID] AutoNumber; primary key");
    expect(text).toMatch(/Relationships[\s\S]*\[Customers\]\.\[CustomerID\] -> \[Orders\]\.\[CustomerID\]/);
    expect(text).toContain("Saved queries");
    expect(text).not.toMatch(/@/); // no e-mail addresses
  });
});
