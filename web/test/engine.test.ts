import { describe, expect, it, vi } from "vitest";

vi.mock("sql.js/dist/sql-wasm.wasm?url", async () => {
  const { createRequire } = await import("node:module");
  return { default: createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm") };
});

import { translateAccessSql, parseAccessDate } from "../src/engine/accessSql";
import { runQuery } from "../src/engine/engine";
import { designToSql, criteriaToSql, designJoins } from "../src/engine/queryDesign";
import { buildTemplate } from "../../shared/templates";

describe("Access SQL translation", () => {
  it("converts Access-isms to SQLite", () => {
    expect(translateAccessSql(`SELECT [a] & " x" FROM [T] WHERE d > #1/31/2026# AND n Like "A*" AND ok = Yes`)).toBe(
      `SELECT [a] || ' x' FROM [T] WHERE d > '2026-01-31' AND n Like 'A%' AND ok = 1`,
    );
    expect(translateAccessSql(`SELECT 'it''s', "say ""hi"""`)).toBe(`SELECT 'it''s', 'say "hi"'`);
  });
  it("parses dates", () => {
    expect(parseAccessDate("2026-02-30")).toBeNull();
    expect(parseAccessDate("12/31/2026 1:05 PM")).toBe("2026-12-31T13:05");
  });
});

describe("query design", () => {
  it("builds criteria", () => {
    expect(criteriaToSql("[T].[n]", "Smith")).toBe(`[T].[n] = "Smith"`);
    expect(criteriaToSql("[T].[n]", ">5")).toBe(`[T].[n] >5`);
    expect(criteriaToSql("[T].[n]", "S*")).toBe(`[T].[n] Like "S*"`);
  });
  it("joins related tables", () => {
    const doc = buildTemplate("contacts");
    const sql = designToSql(doc, ["Customers", "Orders"], [
      { table: "Customers", field: "LastName", show: true, sort: "ASC", criteria: "" },
      { table: "Orders", field: "Amount", show: true, sort: "", criteria: ">40" },
    ]);
    expect(sql).toContain("INNER JOIN [Orders] ON [Customers].[CustomerID] = [Orders].[CustomerID]");
  });
  it("reports the joins to draw, in either table order", () => {
    const doc = buildTemplate("contacts");
    for (const order of [["Customers", "Orders"], ["Orders", "Customers"]]) {
      const { joins, unjoined } = designJoins(doc, order);
      expect(unjoined).toEqual([]);
      expect(joins).toHaveLength(1);
      expect(joins[0]).toMatchObject({ fromTable: "Customers", fromField: "CustomerID", toTable: "Orders", toField: "CustomerID" });
      const sql = designToSql(doc, order, [{ table: order[0], field: "*", show: true, sort: "", criteria: "" }]);
      expect(sql).toContain(`FROM [${order[0]}] INNER JOIN [${order[1]}] ON [Customers].[CustomerID] = [Orders].[CustomerID]`);
    }
  });
});

describe("linked MySQL tables", () => {
  it("joins linked tables through their foreign keys, like related tables", () => {
    const doc = buildTemplate("blank");
    doc.linkedTables = [
      { id: "lt1", name: "customers", connectionId: "c1", remoteTable: "customers", foreignKeys: [] },
      {
        id: "lt2",
        name: "orders",
        connectionId: "c1",
        remoteTable: "orders",
        foreignKeys: [
          { name: "fk_cust", refTable: "customers", columns: [{ field: "customer_id", refField: "id" }] },
          { name: "fk_line", refTable: "lines", columns: [{ field: "a", refField: "a" }, { field: "b", refField: "b" }] },
        ],
      },
      { id: "lt3", name: "lines", connectionId: "c1", remoteTable: "lines" },
      // Same table name on another server: not related.
      { id: "lt4", name: "customers2", connectionId: "c2", remoteTable: "customers" },
    ];
    expect(designJoins(doc, ["orders", "customers"]).joins).toMatchObject([{ fromTable: "customers", fromField: "id", toTable: "orders", toField: "customer_id", enforce: true }]);
    const sql = designToSql(doc, ["customers", "orders", "lines"], [{ table: "orders", field: "*", show: true, sort: "", criteria: "" }]);
    expect(sql).toContain("FROM ([customers] INNER JOIN [orders] ON [customers].[id] = [orders].[customer_id]) INNER JOIN [lines] ON ([lines].[a] = [orders].[a]) AND ([lines].[b] = [orders].[b])");
    expect(designJoins(doc, ["customers2", "orders"]).unjoined).toEqual(["orders"]);
  });
});

describe("query engine", () => {
  const doc = buildTemplate("contacts");
  it("runs every sample query", async () => {
    for (const q of doc.queries) {
      const r = await runQuery(doc, q.sql, { excludeQueryId: q.id });
      expect(r.rows.length, q.name).toBeGreaterThan(0);
    }
    const active = await runQuery(doc, doc.queries[0].sql);
    expect(active.rows.map((r) => r[1])).toEqual(["Dijkstra", "Hopper", "Johnson", "Lovelace"]);
    const totals = await runQuery(doc, doc.queries[1].sql);
    expect(totals.rows[0]).toEqual(["Ada Lovelace", 2, 1295.5]);
  });
  it("supports Access functions, queries-as-views and design SQL", async () => {
    const r = await runQuery(doc, `SELECT UCase(Left([FirstName], 3)) AS a, Year([CustomerSince]) AS y, Nz(NULL, "z") AS z FROM [Customers] WHERE [CustomerID] = 1`);
    expect(r.rows[0]).toEqual(["ADA", 2026, "z"]);
    const v = await runQuery(doc, `SELECT COUNT(*) FROM [Order Details]`);
    expect(v.rows[0][0]).toBe(7);
    const sql = designToSql(doc, ["Customers", "Orders"], [
      { table: "Customers", field: "LastName", show: true, sort: "ASC", criteria: "" },
      { table: "Orders", field: "Amount", show: true, sort: "", criteria: ">40" },
      { table: "Orders", field: "OrderDate", show: false, sort: "", criteria: ">=#6/15/2026#" },
    ]);
    const d = await runQuery(doc, sql);
    expect(d.rows).toEqual([["Hopper", 89.99], ["Lovelace", 45.5], ["Turing", 640]]);
  });
  it("gives friendly errors and refuses non-SELECT", async () => {
    await expect(runQuery(doc, "SELECT * FROM Nope")).rejects.toThrow(/can't find the table or query 'Nope'/);
    await expect(runQuery(doc, "DELETE FROM Customers")).rejects.toThrow(/action query/);
  });
});

describe("editable query results", () => {
  const doc = buildTemplate("contacts");
  const run = (sql: string) => runQuery(doc, sql, { editable: true });

  it("maps a designed query's columns back to table fields and rows", async () => {
    const r = await run(doc.queries[0].sql); // Active Customers
    expect(r.edit?.ok).toBe(true);
    if (!r.edit?.ok) return;
    expect(r.columns).toEqual(["FirstName", "LastName", "City"]);
    expect(r.edit.columns.map((c) => c?.fieldId)).toEqual(["c_first", "c_last", "c_city"]);
    // First row (sorted by LastName) is Dijkstra, customer 5.
    expect(r.rows[0][1]).toBe("Dijkstra");
    expect(r.edit.rowIds[0]).toEqual(["r_c5"]);
  });

  it("handles joins with aliases, *, and calculated columns", async () => {
    const r = await run(doc.queries[2].sql); // Order Details: alias c/o, a calculated Customer column
    expect(r.edit?.ok).toBe(true);
    if (!r.edit?.ok) return;
    expect(r.columns).toEqual(["City", "Customer", "OrderDate", "Item", "Amount"]);
    expect(r.edit.columns.map((c) => c && `${c.source}:${c.fieldId}`)).toEqual(["0:c_city", null, "1:o_date", "1:o_item", "1:o_amount"]);
    const star = await run("SELECT o.*, c.City AS Town FROM Orders AS o INNER JOIN Customers c ON c.CustomerID = o.CustomerID WHERE o.OrderID = 3");
    expect(star.edit?.ok && star.edit.columns.map((c) => c?.fieldId)).toEqual(["o_id", "o_cust", "o_date", "o_item", "o_amount", "c_city"]);
    expect(star.edit?.ok && star.edit.rowIds[0]).toEqual(["r_o3", "r_c2"]);
  });

  it("keeps totals, DISTINCT, unions and query-based queries read-only, like Access", async () => {
    for (const [sql, why] of [
      [doc.queries[1].sql, /totals|groups/],
      ["SELECT DISTINCT City FROM Customers", /DISTINCT/],
      ["SELECT City FROM Customers UNION SELECT Item FROM Orders", /union/],
      ["SELECT * FROM [Order Details]", /based on the query/],
      ["SELECT * FROM Customers WHERE CustomerID IN (SELECT CustomerID FROM Orders)", /subquery/],
    ] as const) {
      const r = await run(sql);
      expect(r.edit?.ok, sql).toBe(false);
      expect(r.edit && !r.edit.ok && r.edit.reason, sql).toMatch(why);
      expect(r.rows.length, sql).toBeGreaterThan(0);
    }
  });
});

import { planAction, previewAction } from "../src/engine/actions";
import { designSql, designProblem } from "../src/engine/queryDesign";
import { queryTypeOf } from "../src/engine/statements";
import type { ProjectDoc } from "../../shared/model";

describe("query types", () => {
  const fresh = () => buildTemplate("contacts");
  const apply = async (doc: ProjectDoc, sql: string) => {
    const plan = await planAction(doc, sql);
    const next = structuredClone(doc);
    plan.apply(next);
    return { plan, next };
  };
  const col = (table: string, field: string, extra: object = {}) => ({ table, field, show: true, sort: "" as const, criteria: "", ...extra });

  it("designs SQL for each type, the way Access writes it", () => {
    const doc = fresh();
    const t = ["Orders"];
    expect(designSql(doc, { type: "update", tables: t, columns: [col("Orders", "Amount", { updateTo: "[Amount]*1.1", criteria: "<20" })] })).toBe(
      "UPDATE [Orders]\nSET [Orders].[Amount] = [Amount]*1.1\nWHERE [Orders].[Amount] <20;",
    );
    expect(designSql(doc, { type: "delete", tables: t, columns: [col("Orders", "*"), col("Orders", "Amount", { criteria: "<20" })] })).toBe(
      "DELETE [Orders].*\nFROM [Orders]\nWHERE [Orders].[Amount] <20;",
    );
    expect(designSql(doc, { type: "makeTable", target: "Big", tables: t, columns: [col("Orders", "Item"), col("Orders", "Amount", { criteria: ">100" })] })).toBe(
      "SELECT [Orders].[Item], [Orders].[Amount]\nINTO [Big]\nFROM [Orders]\nWHERE [Orders].[Amount] >100;",
    );
    expect(
      designSql(doc, { type: "select", totals: true, tables: t, columns: [col("Orders", "CustomerID"), col("Orders", "Amount", { total: "Sum", sort: "DESC" })] }),
    ).toBe("SELECT [Orders].[CustomerID], Sum([Orders].[Amount]) AS SumOfAmount\nFROM [Orders]\nGROUP BY [Orders].[CustomerID]\nORDER BY Sum([Orders].[Amount]) DESC;");
    const xtab = {
      type: "crosstab" as const,
      tables: t,
      columns: [col("Orders", "CustomerID", { crosstab: "row" }), col("Orders", "Item", { crosstab: "column" }), col("Orders", "Amount", { crosstab: "value", total: "Sum" })],
    };
    expect(designProblem(doc, xtab)).toBeNull();
    expect(designSql(doc, xtab)).toBe(
      "TRANSFORM Sum([Orders].[Amount]) AS SumOfAmount\nSELECT [Orders].[CustomerID]\nFROM [Orders]\nGROUP BY [Orders].[CustomerID]\nPIVOT [Orders].[Item];",
    );
    expect(designProblem(doc, { ...xtab, columns: xtab.columns.slice(0, 2) })).toMatch(/exactly one Value/);
    expect(queryTypeOf("SELECT a INTO b FROM c")).toBe("makeTable");
    expect(queryTypeOf("TRANSFORM Sum(x) SELECT y FROM z GROUP BY y PIVOT w")).toBe("crosstab");
  });

  it("runs totals and crosstab queries", async () => {
    const doc = fresh();
    const totals = await runQuery(doc, "SELECT c.City, Count(*) AS N, Sum(o.Amount) AS Total, StDev(o.Amount) AS S, First(o.Item) AS F FROM Customers c INNER JOIN Orders o ON o.CustomerID = c.CustomerID GROUP BY c.City ORDER BY c.City");
    expect(totals.rows[0]).toEqual(["Arlington", 2, 93.49, expect.any(Number), "COBOL manual"]);
    const x = await runQuery(doc, "TRANSFORM Sum(o.[Amount]) AS SumOfAmount SELECT c.[City] FROM Customers AS c INNER JOIN Orders AS o ON o.CustomerID = c.CustomerID GROUP BY c.[City] PIVOT Month(o.[OrderDate]);");
    expect(x.columns).toEqual(["City", "6", "7", "8", "9", "10"]);
    expect(x.rows.find((r) => r[0] === "London")).toEqual(["London", 1250, 45.5, null, null, null]);
    const fixed = await runQuery(doc, "TRANSFORM Count(*) SELECT Active FROM Customers GROUP BY Active PIVOT City IN ('London', 'Austin')");
    expect(fixed.columns).toEqual(["Active", "London", "Austin"]);
  });

  it("runs update queries and skips records that would break keys", async () => {
    const doc = fresh();
    const { plan, next } = await apply(doc, "UPDATE Orders SET Orders.Amount = [Amount]*2 WHERE Orders.Amount < 20");
    expect(plan.count).toBe(2);
    expect(next.tables[1].rows.map((r) => r.o_amount)).toEqual([1250, 45.5, 89.99, 640, 32, 25.5, 7]);
    const dup = await planAction(doc, "UPDATE Customers SET Email = 'ada@example.com' WHERE CustomerID = 2");
    expect(dup.count).toBe(0);
    expect(dup.problems[0]).toMatch(/key violations/);
    const preview = await previewAction(doc, "UPDATE Orders SET Orders.Amount = 0 WHERE Amount < 20");
    expect(preview.rows).toEqual([[12.75], [3.5]]);
  });

  it("runs delete queries, keeping records related records still use", async () => {
    const doc = fresh();
    const { plan, next } = await apply(doc, "DELETE [Orders].* FROM [Orders] WHERE [Orders].[Amount] < 20;");
    expect(plan.count).toBe(2);
    expect(next.tables[1].rows).toHaveLength(5);
    const blocked = await planAction(doc, "DELETE * FROM Customers WHERE City = 'London'");
    expect(blocked.count).toBe(0);
    expect(blocked.problems[0]).toMatch(/related records/);
  });

  it("runs append queries with AutoNumbers, defaults and relationship checks", async () => {
    const doc = fresh();
    const { plan, next } = await apply(doc, `INSERT INTO Orders (CustomerID, Item, Amount, OrderDate) SELECT CustomerID, "Gift card", 25, #11/1/2026# FROM Customers WHERE Active`);
    expect(plan.count).toBe(4);
    const added = next.tables[1].rows.slice(7);
    expect(added.map((r) => r.o_id)).toEqual([8, 9, 10, 11]);
    expect(added[0]).toMatchObject({ o_item: "Gift card", o_amount: 25, o_date: "2026-11-01" });
    expect(next.tables[1].nextAutoNumber).toBe(12);
    const orphan = await planAction(doc, "INSERT INTO Orders (CustomerID, Item) VALUES (99, 'Nobody')");
    expect(orphan.count).toBe(0);
    expect(orphan.problems[0]).toMatch(/key violations/);
  });

  it("runs make-table queries, inferring field types", async () => {
    const doc = fresh();
    const { plan, next } = await apply(doc, "SELECT City, Count(*) AS Customers INTO CityCounts FROM Customers GROUP BY City");
    expect(plan.count).toBe(5);
    const t = next.tables.find((x) => x.name === "CityCounts")!;
    expect(t.fields.map((f) => `${f.name}:${f.type}`)).toEqual(["City:ShortText", "Customers:Number"]);
    // Running it again replaces the table, keeping its id.
    const again = await planAction(next, "SELECT City INTO CityCounts FROM Customers");
    expect(again.replaces).toMatch(/will be deleted/);
    const after = structuredClone(next);
    again.apply(after);
    expect(after.tables.find((x) => x.name === "CityCounts")!.id).toBe(t.id);
    await expect(planAction(doc, "SELECT City INTO [Order Details] FROM Customers")).rejects.toThrow(/query is already named/);
  });
});
