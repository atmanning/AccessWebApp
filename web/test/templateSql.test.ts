/** SQL the Access templates use: DISTINCTROW, IsNull(), Form![ID], [Application].[CurrentObjectName], MSysObjects. */
import { describe, expect, it, vi } from "vitest";

vi.mock("sql.js/dist/sql-wasm.wasm?url", async () => {
  const { createRequire } = await import("node:module");
  return { default: createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm") };
});

import type { ProjectDoc } from "../../shared/model";
import { translateAccessSql } from "../src/engine/accessSql";
import { preloadSql, runQuery } from "../src/engine/engine";
import { makeFormCalc } from "../src/forms/formCalc";
import { parseAccessDate } from "../src/engine/accessSql";

function lendingDoc(): ProjectDoc {
  const f = (id: string, name: string, type = "ShortText", extra = {}) => ({ id, name, type, ...extra });
  return {
    version: 1,
    tables: [
      {
        id: "t1",
        name: "Contacts",
        fields: [f("c1", "ID", "AutoNumber", { primaryKey: true }), f("c2", "Company"), f("c3", "Last Name"), f("c4", "First Name")],
        rows: [
          { _id: "r1", c1: 1, c2: "Acme", c3: null, c4: null },
          { _id: "r2", c1: 2, c2: null, c3: "Lee", c4: "Ann" },
          { _id: "r3", c1: 3, c2: null, c3: null, c4: "Bo" },
        ],
      },
      {
        id: "t2",
        name: "Filters",
        fields: [f("f1", "ID", "AutoNumber", { primaryKey: true }), f("f2", "Object Name"), f("f3", "Filter Name")],
        rows: [
          { _id: "r1", f1: 1, f2: "Asset List", f3: "Mine" },
          { _id: "r2", f1: 2, f2: "Contact List", f3: "Theirs" },
        ],
      },
    ],
    queries: [
      {
        id: "q1",
        name: "Contacts Extended",
        mode: "sql",
        sql: `SELECT DISTINCTROW IIf(IsNull([Last Name]),IIf(IsNull([First Name]),[Company],[First Name]),[Last Name] & ", " & [First Name]) AS [File As], Contacts.* FROM Contacts ORDER BY Contacts.ID;`,
      },
    ],
    forms: [{ id: "fm1", name: "Asset List", title: "Asset List", source: { kind: "table", id: "t2" }, columns: [] }],
    reports: [{ id: "rp1", name: "All Assets", title: "All Assets", source: { kind: "query", id: "q1" }, columns: [] }],
    relationships: [],
  } as unknown as ProjectDoc;
}

describe("SQL from Access templates", () => {
  it("translates DISTINCTROW, IsNull() and Table!Field", () => {
    expect(translateAccessSql("SELECT DISTINCTROW T.* FROM T WHERE IsNull (T!x)")).toBe("SELECT T.* FROM T WHERE acc_isnull (T.x)");
  });

  it("runs queries that use them", async () => {
    const r = await runQuery(lendingDoc(), "SELECT [File As] FROM [Contacts Extended]");
    expect(r.rows.map((x) => x[0])).toEqual(["Acme", "Lee, Ann", "Bo"]);
  });

  it("fills in references to the form and the application", async () => {
    const doc = lendingDoc();
    const sql = `SELECT ID FROM Filters WHERE [Object Name]=[Application].[CurrentObjectName] AND ID<>Nz(Form![ID],0)`;
    const mine = await runQuery(doc, sql, { refs: { formName: "Asset List", form: () => undefined } });
    expect(mine.rows).toEqual([[1]]);
    const none = await runQuery(doc, sql, { refs: { formName: "Asset List", form: (n) => (n === "ID" ? 1 : undefined) } });
    expect(none.rows).toEqual([]);
    // An unknown reference is Null, so the query still runs.
    const all = await runQuery(doc, "SELECT ID FROM Filters WHERE ID<>Nz([Forms]![Nope]![ID],0)");
    expect(all.rows).toHaveLength(2);
  });

  it("lists forms and reports in MSysObjects", async () => {
    const r = await runQuery(lendingDoc(), `SELECT MSysObjects.Name FROM MSysObjects WHERE MSysObjects.Type=-32764 AND Name Not Like "*Sub*"`);
    expect(r.rows).toEqual([["All Assets"]]);
  });
});

describe("expressions from Access templates", () => {
  it("counts a query's records with DCount", async () => {
    await preloadSql();
    const doc = lendingDoc();
    const calc = makeFormCalc(doc, { controls: [] }, []);
    expect(calc.evaluate(`=DCount("*","[Contacts Extended]","[File As] Like 'L*'")`, null, () => [])).toBe(1);
  });

  it("allows IIf without its false part, and Time() as a time", () => {
    const calc = makeFormCalc(lendingDoc(), { controls: [] }, []);
    expect(calc.evaluate(`=IIf([Filter]<>"" And [FilterOn],"x")`, null, () => [], { Filter: "", FilterOn: false })).toBeNull();
    expect(parseAccessDate("1:05 PM")).toBe("1899-12-30T13:05");
    expect(calc.preview(`=Time()`, null, () => [], "Long Time").error).toBeUndefined();
  });
});
