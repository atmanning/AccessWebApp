import { describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import { createRequire } from "node:module";
import { buildTemplate } from "../../shared/templates";
import { exportSchema } from "../src/engine/schemaExport";

const doc = buildTemplate("contacts");
const ids = doc.tables.map((t) => t.id);

describe("Export Schema", () => {
  it("writes MySQL DDL with keys, auto-increment, indexes and foreign keys", () => {
    const { text, extension } = exportSchema(doc, ids, "mysql", { databaseName: "Contacts" });
    expect(extension).toBe("sql");
    expect(text).toContain("CREATE TABLE `Customers` (");
    expect(text).toContain("`CustomerID` INT NOT NULL AUTO_INCREMENT,");
    expect(text).toContain("`FirstName` VARCHAR(50) NOT NULL,");
    expect(text).toMatch(/`Active` TINYINT\(1\) DEFAULT 1/);
    expect(text).toContain("FOREIGN KEY (`CustomerID`) REFERENCES `Customers` (`CustomerID`)");
    // Parents come first, so the foreign key can be inline.
    expect(text.indexOf("CREATE TABLE `Customers`")).toBeLessThan(text.indexOf("CREATE TABLE `Orders`"));
    expect(text).toContain("CREATE UNIQUE INDEX `ix_Customers_Email` ON `Customers` (`Email`);");
  });

  it("writes SQLite DDL that SQLite accepts", async () => {
    const SQL = await initSqlJs({ locateFile: () => createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm") });
    const db = new SQL.Database();
    const { text } = exportSchema(doc, ids, "sqlite");
    db.exec(text);
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")[0].values.flat();
    expect(tables).toEqual(["Customers", "Orders"]);
    expect(db.exec("PRAGMA foreign_key_list(Orders)")[0].values[0]).toContain("Customers");
    db.exec(`INSERT INTO Customers (FirstName, LastName) VALUES ('A', 'B')`);
    expect(db.exec("SELECT CustomerID, Active FROM Customers")[0].values).toEqual([[1, 1]]);
  });

  it("writes Access DDL, a document and JSON for just the chosen tables", () => {
    const access = exportSchema(doc, ids, "access").text;
    expect(access).toContain("[CustomerID] COUNTER");
    expect(access).toContain("[FirstName] TEXT(50) NOT NULL");
    const one = exportSchema(doc, [doc.tables[0].id], "markdown").text;
    expect(one).toContain("## Customers");
    expect(one).not.toContain("## Orders");
    const json = JSON.parse(exportSchema(doc, ids, "json").text);
    expect(json.tables.map((t: { name: string }) => t.name)).toEqual(["Customers", "Orders"]);
    expect(json.relationships[0]).toMatchObject({ from: "Customers.CustomerID", to: "Orders.CustomerID", enforce: true });
  });
});
