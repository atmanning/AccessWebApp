import { describe, expect, it } from "vitest";
import type { Field } from "../../shared/model";
import { richToPlain } from "../../shared/values";
import { chartGroups } from "../src/forms/FormChart";
import { makeFormCalc } from "../src/forms/formCalc";
import { tempVars } from "../src/macros/runtime";

describe("form charts", () => {
  it("groups records by the category and totals each series", () => {
    const fields = [{ type: "DateTime" }, { type: "Number" }] as Field[];
    const rows = [
      ["2026-11-02", 3],
      ["2026-11-01", 1],
      ["2026-11-02", 4],
      ["2026-11-01", null],
    ];
    const g = chartGroups({ type: "column", category: "Date", series: [{ field: "N", agg: "sum" }, { field: "N", agg: "count" }] }, ["Date", "N"], fields, rows);
    expect(g.map((x) => [x.key, x.values])).toEqual([
      ["2026-11-01", [1, 1]],
      ["2026-11-02", [7, 2]],
    ]);
  });
});

describe("template expressions", () => {
  it("shows Access Rich Text as its words, and reads TempVars(\"Name\") and Rnd()", () => {
    expect(richToPlain('<div><font face="Arial" color="#333399">Eat &amp; drink <strong>well</strong></font></div><div>Sleep</div>')).toBe("Eat & drink well\nSleep");
    expect(richToPlain("a < b and <c>")).toBe("a < b and <c>");
    tempVars.set("daily", 2000);
    const calc = makeFormCalc({ tables: [], queries: [], forms: [], reports: [] } as never, { controls: [] } as never, []);
    expect(calc.evaluate(`=TempVars("Daily")*0.3`, null, () => [])).toBe(600);
    const r = calc.evaluate("=Rnd()", null, () => []) as number;
    expect(r >= 0 && r < 1).toBe(true);
  });
});
