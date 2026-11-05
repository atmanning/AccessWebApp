import { describe, expect, it } from "vitest";
import { compileCriteria } from "../src/engine/findCriteria";
import type { CellValue, Field } from "../../shared/model";

const f = (type: Field["type"]) => ({ type, name: "F" });
const check = (crit: string, type: Field["type"], values: CellValue[], shown?: string[], lookup = false) => {
  const c = compileCriteria(crit, f(type), { lookup });
  if (!c.ok) throw new Error(c.error);
  return values.filter((v, i) => c.test(v, shown?.[i]));
};

describe("Find mode criteria", () => {
  it("text: contains by default, = for exact, wildcards, blank and any", () => {
    const names = ["Smith", "Smithers", "Goldsmith", "smith", null, ""];
    expect(check("smith", "ShortText", names)).toEqual(["Smith", "Smithers", "Goldsmith", "smith"]);
    expect(check("=Smith", "ShortText", names)).toEqual(["Smith", "smith"]);
    expect(check("Smith*", "ShortText", names)).toEqual(["Smith", "Smithers", "smith"]);
    expect(check('Like "*smith"', "ShortText", names)).toEqual(["Smith", "Goldsmith", "smith"]);
    expect(check("=", "ShortText", names)).toEqual([null, ""]);
    expect(check("*", "ShortText", names)).toHaveLength(4);
    expect(check("Smith Or Gold*", "ShortText", names)).toEqual(["Smith", "Smithers", "Goldsmith", "smith"]);
    expect(check("Not smith", "ShortText", ["Smith", "Jones", null])).toEqual(["Jones"]);
    expect(check('In ("Jones", "smith")', "ShortText", ["Smith", "Jones", "Brown"])).toEqual(["Smith", "Jones"]);
  });

  it("numbers: equals, comparisons, ranges", () => {
    const n = [5, 10, 15, 20, null];
    expect(check("10", "Number", n)).toEqual([10]);
    expect(check(">10", "Currency", n)).toEqual([15, 20]);
    expect(check("<= 10", "Number", n)).toEqual([5, 10]);
    expect(check("10...15", "Number", n)).toEqual([10, 15]);
    expect(check("Between 6 And 19", "Number", n)).toEqual([10, 15]);
    expect(check("<>10", "Number", n)).toEqual([5, 15, 20]);
    expect(check("$1,000", "Currency", [1000, 999])).toEqual([1000]);
    expect(compileCriteria("abc", f("Number")).ok).toBe(false);
  });

  it("dates: a day matches any time that day; ranges inclusive", () => {
    const d = ["2026-01-12", "2026-02-03T13:05", "2026-03-21", null];
    expect(check("2/3/2026", "DateTime", d)).toEqual(["2026-02-03T13:05"]);
    expect(check("1/1/2026...2/28/2026", "DateTime", d)).toEqual(["2026-01-12", "2026-02-03T13:05"]);
    expect(check(">#3/1/2026#", "DateTime", d)).toEqual(["2026-03-21"]);
    expect(compileCriteria("someday", f("DateTime"))).toMatchObject({ ok: false });
  });

  it("yes/no", () => {
    expect(check("Yes", "YesNo", [true, false, 1, 0])).toEqual([true, 1]);
    expect(check("No", "YesNo", [true, false])).toEqual([false]);
  });

  it("lookups match what's shown as well as what's stored", () => {
    const ids = [1, 2, 3];
    const names = ["Lovelace", "Hopper", "Turing"];
    expect(check("hop", "Number", ids, names, true)).toEqual([2]);
    expect(check("=Turing", "Number", ids, names, true)).toEqual([3]);
    expect(check("2", "Number", ids, names, true)).toEqual([2]);
    expect(check("L*", "Number", ids, names, true)).toEqual([1]);
  });
});
