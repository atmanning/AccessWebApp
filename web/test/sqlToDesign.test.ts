import { describe, expect, it, vi } from "vitest";

vi.mock("sql.js/dist/sql-wasm.wasm?url", async () => {
  const { createRequire } = await import("node:module");
  return { default: createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm") };
});

import { runQuery } from "../src/engine/engine";
import { designSql } from "../src/engine/queryDesign";
import { sqlToDesign } from "../src/engine/sqlToDesign";
import { buildTemplate } from "../../shared/templates";
import { projectDocSchema } from "../../shared/model";

const doc = buildTemplate("contacts");
const canon = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();

/** Parses, regenerates, and checks the regenerated SQL gives the same results. */
async function roundTrip(sql: string, ordered = false) {
  const original = await runQuery(doc, sql);
  const parsed = sqlToDesign(doc, sql, { outputNames: original.columns });
  if (!parsed.ok) throw new Error(parsed.reason);
  // The design must be storable.
  projectDocSchema.parse({ ...doc, queries: [{ id: "q_t", name: "T", mode: "design", sql: "", design: parsed.design }] });
  const regenerated = designSql(doc, parsed.design);
  const again = await runQuery(doc, regenerated);
  expect(again.columns, regenerated).toEqual(original.columns);
  if (ordered) expect(again.rows, regenerated).toEqual(original.rows);
  else expect(canon(again.rows), regenerated).toEqual(canon(original.rows));
  // Reading the regenerated SQL gives the same design again.
  const second = sqlToDesign(doc, regenerated, { outputNames: again.columns });
  expect(second.ok && designSql(doc, second.design)).toBe(regenerated);
  return { design: parsed.design, sql: regenerated };
}

describe("SQL to Design View", () => {
  it("reads every sample select query", async () => {
    for (const q of doc.queries) await roundTrip(q.sql, /ORDER BY/i.test(q.sql));
  });

  it("puts criteria in the grid like Access", async () => {
    const { design } = await roundTrip(`SELECT City, LastName FROM Customers WHERE City = "London" AND Active = True ORDER BY LastName;`, true);
    expect(design.columns.map((c) => [c.field, c.show, c.criteria, c.sort])).toEqual([
      ["City", true, '"London"', ""],
      ["LastName", true, "", "ASC"],
      ["Active", false, "= True", ""],
    ]);
  });

  it("turns OR into or: rows", async () => {
    const { design } = await roundTrip(`SELECT FirstName, City FROM Customers WHERE City = "London" OR (City Like "A*" AND FirstName <> "Grace") OR CustomerID > 4`);
    const city = design.columns.find((c) => c.field === "City")!;
    expect([city.criteria, ...(city.or ?? [])]).toEqual(['"London"', 'Like "A*"']);
    const first = design.columns.find((c) => c.field === "FirstName")!;
    expect(first.or).toEqual(['<> "Grace"']);
    expect(design.columns.find((c) => c.field === "CustomerID")!.or).toEqual(["", "> 4"]);
  });

  it("reads expressions, aliases, Between, In, Is Null and Not", async () => {
    await roundTrip(`SELECT [FirstName] & " " & [LastName] AS FullName, Year([CustomerSince]) AS Joined FROM Customers WHERE CustomerSince Between #1/1/2026# And #12/31/2026# AND City In ("London", "Austin") AND Email Is Not Null AND NOT Active = False ORDER BY 2 DESC, FullName`, true);
    const { design } = await roundTrip(`SELECT City AS Town, Len([Email]) FROM Customers WHERE Len([Email]) > 18`);
    expect(design.columns[0]).toMatchObject({ field: "City", alias: "Town" });
    expect(design.columns[1]).toMatchObject({ expr: true, field: "Len([Email])", criteria: "> 18" });
  });

  it("reads joins with table aliases, including outer joins", async () => {
    const inner = await roundTrip(`SELECT c.LastName, o.Item FROM Customers AS c INNER JOIN Orders AS o ON c.CustomerID = o.CustomerID`);
    expect(inner.design.joins).toEqual([{ t1: "Customers", f1: "CustomerID", t2: "Orders", f2: "CustomerID", kind: "inner" }]);
    const left = await roundTrip(`SELECT Customers.LastName, Orders.Item FROM Customers LEFT JOIN Orders ON Orders.CustomerID = Customers.CustomerID`);
    expect(left.design.joins![0]).toMatchObject({ t1: "Orders", t2: "Customers", kind: "right" });
    expect(left.sql).toContain("FROM [Customers] LEFT JOIN [Orders]");
    await roundTrip(`SELECT Customers.LastName, Orders.Item FROM Orders RIGHT OUTER JOIN Customers ON Orders.CustomerID = Customers.CustomerID`);
    await roundTrip(`SELECT Customers.LastName, Orders.Item FROM Customers, Orders WHERE Orders.CustomerID = Customers.CustomerID AND Orders.Amount > 10`);
  });

  it("reads totals: Group By, Sum, Count(*), Where, Having, Expression", async () => {
    const { design } = await roundTrip(
      `SELECT c.City, Count(*) AS N, Sum(o.Amount) AS Total, Max(o.Amount) - Min(o.Amount) AS Spread FROM Customers c INNER JOIN Orders o ON o.CustomerID = c.CustomerID WHERE o.Amount > 1 GROUP BY c.City HAVING Sum(o.Amount) > 10 ORDER BY Sum(o.Amount) DESC`,
      true,
    );
    expect(design.totals).toBe(true);
    expect(design.columns.map((c) => c.total)).toEqual(["Group By", "Count", "Sum", "Expression", "Where"]);
    expect(design.columns[2]).toMatchObject({ criteria: "> 10", sort: "DESC" });
    // Unnamed totals keep the names SQL gave them.
    await roundTrip(`SELECT City, Count(CustomerID) FROM Customers GROUP BY City`);
    const counted = await roundTrip(`SELECT CustomerID, Count(*) AS N FROM Orders GROUP BY CustomerID HAVING Count(*) > 1 ORDER BY Count(*) DESC`, true);
    expect(counted.design.columns[1]).toMatchObject({ field: "*", total: "Count", criteria: "> 1", sort: "DESC" });
  });

  it("reads DISTINCT, SELECT * and [Table].*", async () => {
    expect((await roundTrip(`SELECT DISTINCT City FROM Customers`)).design.distinct).toBe(true);
    await roundTrip(`SELECT * FROM Customers ORDER BY City DESC, LastName`, true);
    await roundTrip(`SELECT Orders.*, Customers.City FROM Customers INNER JOIN Orders ON Customers.CustomerID = Orders.CustomerID`);
  });

  it("keeps sort order when ORDER BY isn't left to right", async () => {
    const { design } = await roundTrip(`SELECT FirstName, City FROM Customers ORDER BY City, FirstName DESC`, true);
    expect(design.columns.map((c) => [c.field, c.show, c.sort])).toEqual([
      ["FirstName", true, ""],
      ["City", true, "ASC"],
      ["FirstName", false, "DESC"],
    ]);
  });

  it("keeps the meaning of NOT, nested brackets and mixed AND/OR", async () => {
    const { design } = await roundTrip(`SELECT LastName FROM Customers WHERE NOT CustomerID = 3`);
    expect(design.columns[1]).toMatchObject({ expr: true, field: "NOT CustomerID = 3", criteria: "<> False", show: false });
    await roundTrip(`SELECT LastName FROM Customers WHERE ((City = "London" OR City = "Austin") AND Active = True)`);
    await roundTrip(`SELECT LastName FROM Customers WHERE (City = "London" OR City = "Austin") AND (CustomerID < 3 OR CustomerID > 4)`);
    await roundTrip(`SELECT Item, Amount FROM Orders WHERE Amount * 2 >= 100 OR Item Like "*o*" ORDER BY Amount * 2 DESC`, true);
  });

  it("reads totals with WHERE and HAVING that use OR", async () => {
    await roundTrip(`SELECT CustomerID, Sum(Amount) AS Total FROM Orders WHERE Amount > 5 OR Item = "Pen" GROUP BY CustomerID HAVING Sum(Amount) > 40 OR Count(*) > 1`);
  });

  it("uses saved queries as sources", async () => {
    await roundTrip(`SELECT [Active Customers].City, Count(*) AS N FROM [Active Customers] GROUP BY [Active Customers].City`);
  });

  it("explains what it can't show yet", () => {
    const why = (sql: string) => {
      const r = sqlToDesign(doc, sql);
      return r.ok ? "ok" : r.reason;
    };
    expect(why(`SELECT City FROM Customers UNION SELECT Item FROM Orders`)).toMatch(/Union/);
    expect(why(`SELECT City FROM Customers WHERE CustomerID IN (SELECT CustomerID FROM Orders)`)).toMatch(/subqueries/);
    expect(why(`SELECT TOP 5 City FROM Customers`)).toMatch(/TOP/);
    expect(why(`UPDATE Customers SET City = "X"`)).toMatch(/select queries/);
    expect(why(`SELECT City FROM Nowhere`)).toMatch(/can't find/);
    expect(why(`SELECT CustomerID FROM Customers, Orders`)).toMatch(/more than one table/);
    expect(why(`SELECT c.City FROM Customers c INNER JOIN Orders o ON o.Amount > 5`)).toMatch(/match two fields/);
  });
});
