import { describe, expect, it, vi } from "vitest";

vi.mock("sql.js/dist/sql-wasm.wasm?url", async () => {
  const { createRequire } = await import("node:module");
  return { default: createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm") };
});

import { translateAccessSql, parseAccessDate } from "../src/engine/accessSql";
import { runQuery } from "../src/engine/engine";
import { designToSql, criteriaToSql } from "../src/engine/queryDesign";
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
    await expect(runQuery(doc, "DELETE FROM Customers")).rejects.toThrow(/Only SELECT/);
  });
});
