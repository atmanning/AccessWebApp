import { describe, expect, it } from "vitest";
import { compileExpression, displayValue, evaluate, formatExpr, rowContext, type ExprContext } from "../src/engine/expr";

const cols = ["FirstName", "LastName", "Qty", "Price", "BirthDate", "Active", "City"];
const rows = [
  ["Ada", "Lovelace", 2, 9.5, "1815-12-10", true, "London"],
  ["Alan", "Turing", 3, 4, "1912-06-23", false, null],
  ["Grace", "Hopper", null, 10, "1906-12-09", true, "Arlington"],
];
const orders = { columns: ["OrderID", "Customer", "Total"], rows: [[1, "Ada", 10], [2, "Ada", 15.5], [3, "Alan", 7]] };
const ctxFor = (r: number): ExprContext =>
  rowContext(cols, rows[r], {
    records: () => rows.map((x) => rowContext(cols, x)),
    domain: (name) => (name.toLowerCase() === "orders" ? orders.rows.map((x) => rowContext(orders.columns, x)) : undefined),
    lookup: (name) => (name.toLowerCase() === "txttotal" ? 99 : undefined),
  });
const run = (src: string, r = 0) => {
  const c = compileExpression(src);
  if (!c.ok) throw new Error(c.error);
  return evaluate(c.node, ctxFor(r));
};

describe("expressions", () => {
  it("joins text and does arithmetic", () => {
    expect(run('=[FirstName] & " " & [LastName]')).toBe("Ada Lovelace");
    expect(run("=[Qty]*[Price]")).toBe(19);
    expect(run("=[Qty]*[Price]", 2)).toBeNull();
    expect(run("=Nz([Qty],0)*[Price]", 2)).toBe(0);
    expect(run("=2+3*4^2")).toBe(50);
    expect(run("=-2^2")).toBe(-4);
    expect(run("=7 \\ 2 & \"/\" & 7 Mod 2")).toBe("3/1");
    expect(run("=0.1+0.2")).toBe(0.3);
    expect(run("=[City] & \"!\"", 1)).toBe("!");
    expect(run("=FirstName")).toBe("Ada");
    expect(run("=[txtTotal]+1")).toBe(100);
  });

  it("handles IIf, Switch, comparisons and Like", () => {
    expect(run('=IIf([Active], "Yes", "No")', 1)).toBe("No");
    expect(run('=IIf([Qty] > 2, "many", "few")', 1)).toBe("many");
    expect(run('=IIf(IsNull([City]), "(none)", [City])', 1)).toBe("(none)");
    expect(run('=Switch([Qty]=2,"two",[Qty]=3,"three")', 1)).toBe("three");
    expect(run('=[LastName] Like "L*"')).toBe(true);
    expect(run('=[Qty] Between 1 And 2')).toBe(true);
    expect(run('=[City] In ("Paris","London")')).toBe(true);
    expect(run('=[FirstName]="ada"')).toBe(true);
    expect(run("=Not [Active]")).toBe(false);
  });

  it("does dates", () => {
    expect(run("=DateDiff(\"yyyy\", [BirthDate], #2026-01-01#)")).toBe(211);
    expect(run("=DateAdd(\"m\", 1, #2026-01-31#)")).toBe("2026-02-28");
    expect(run("=#2026-03-01# - #2026-02-01#")).toBe(28);
    expect(run("=#2026-03-01# + 30")).toBe("2026-03-31");
    expect(run('=Format([BirthDate], "mmmm d, yyyy")')).toBe("December 10, 1815");
    expect(run('=Format([BirthDate], "Long Date")')).toBe("Sunday, December 10, 1815");
    expect(run("=Year([BirthDate]) & \"-\" & MonthName(Month([BirthDate]), True)")).toBe("1815-Dec");
    expect(run("=Weekday(#2026-11-12#)")).toBe(5);
  });

  it("formats numbers", () => {
    expect(formatExpr(1234.5, "Currency")).toBe("$1,234.50");
    expect(formatExpr(-5, "Currency")).toBe("($5.00)");
    expect(formatExpr(0.256, "Percent")).toBe("25.60%");
    expect(formatExpr(3.14159, "0.00")).toBe("3.14");
    expect(formatExpr(1234567, "#,##0")).toBe("1,234,567");
    expect(formatExpr(5, "000")).toBe("005");
    expect(formatExpr(1, "Yes/No")).toBe("Yes");
    expect(displayValue(true)).toBe("Yes");
    expect(displayValue(19, "Currency")).toBe("$19.00");
  });

  it("totals the form's records", () => {
    expect(run("=Sum([Qty])")).toBe(5);
    expect(run("=Count(*)")).toBe(3);
    expect(run("=Count([City])")).toBe(2);
    expect(run("=Avg([Price])")).toBeCloseTo(7.8333, 3);
    expect(run("=Max([LastName])")).toBe("Turing");
    expect(run("=Sum([Qty]*[Price])")).toBe(31);
  });

  it("looks things up in other tables", () => {
    expect(run('=DCount("*", "Orders", "Customer=\'" & [FirstName] & "\'")')).toBe(2);
    expect(run('=DSum("Total", "Orders", "Customer=\'" & [FirstName] & "\'")')).toBe(25.5);
    expect(run('=DLookup("OrderID", "Orders", "Total > 12")')).toBe(2);
    expect(run('=DCount("*", "Orders")')).toBe(3);
    expect(() => run('=DCount("*", "Nope")')).toThrow(/no table/);
  });

  it("explains mistakes", () => {
    const bad = (src: string) => {
      const c = compileExpression(src);
      return c.ok ? "ok" : c.error;
    };
    expect(bad("=[A] &")).toMatch(/ends too soon/);
    expect(bad("=Foo(1)")).toMatch(/no function called Foo/);
    expect(bad("=IIf(1, 2)")).toMatch(/IIf takes 3 values/);
    expect(bad("=Left(«string», 2)")).toMatch(/Replace «string»/);
    expect(bad('="abc')).toMatch(/closing quote/);
    expect(bad("=(1+2")).toMatch(/closing \)/);
    expect(bad("=[A] [B]")).toMatch(/something extra/);
    expect(() => run("=[Nope]")).toThrow(/no field or control named \[Nope\]/);
    expect(() => run("=1/0")).toThrow(/Division by zero/);
  });
});
