import { it, expect } from "vitest";
import { renameInSql } from "../src/workspace/OtherDatabaseDialog";
it("renames only table refs", () => {
  const m = new Map([["orders", "Orders1"], ["customers", "Customers1"]]);
  expect(renameInSql("SELECT COUNT(o.[OrderID]) AS Orders, Orders.Orders, [Orders].[Customers] FROM [Customers] AS c INNER JOIN Orders AS o ON o.x = c.x", m))
    .toBe("SELECT COUNT(o.[OrderID]) AS Orders, [Orders1].Orders, [Orders1].[Customers] FROM [Customers1] AS c INNER JOIN [Orders1] AS o ON o.x = c.x");
});
