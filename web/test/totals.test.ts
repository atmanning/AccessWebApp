import { describe, expect, it } from "vitest";
import { computeTotal, numericColumn, totalsFor } from "../src/views/totals";

describe("datasheet Total row", () => {
  it("offers number totals for numbers, count/max/min for dates, and a count for text", () => {
    expect(totalsFor("Currency", false)).toContain("Average");
    expect(totalsFor(undefined, true)).toContain("Sum");
    expect(totalsFor("DateTime", false)).toEqual(["Count", "Maximum", "Minimum"]);
    expect(totalsFor("ShortText", false)).toEqual(["Count"]);
  });

  it("works totals out over the records, leaving blanks out", () => {
    const v = [0.1, 0.2, null, 3, ""];
    expect(computeTotal("Sum", v)).toBe(3.3);
    expect(computeTotal("Count", v)).toBe(3);
    expect(computeTotal("Average", v)).toBeCloseTo(1.1);
    expect(computeTotal("Maximum", v)).toBe(3);
    expect(computeTotal("Minimum", v)).toBe(0.1);
    expect(computeTotal("StDev", [2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(computeTotal("Var", [1])).toBeNull();
    expect(computeTotal("Maximum", ["2026-01-05", "2026-11-18", null])).toBe("2026-11-18");
    expect(computeTotal("Count", ["a", null, "b"])).toBe(2);
  });

  it("tells whole-number calculated columns from ones that need decimals", () => {
    expect(numericColumn([1, 2, null])).toBe("whole");
    expect(numericColumn([1, 2.5])).toBe("decimal");
    expect(numericColumn(["a", 1])).toBeNull();
    expect(numericColumn([null])).toBeNull();
  });
});
