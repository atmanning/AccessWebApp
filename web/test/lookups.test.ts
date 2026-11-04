import { describe, expect, it, vi } from "vitest";

vi.mock("sql.js/dist/sql-wasm.wasm?url", async () => {
  const { createRequire } = await import("node:module");
  return { default: createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm") };
});

import { produce } from "immer";
import { buildTemplate } from "../../shared/templates";
import { projectDocSchema, type FieldLookup } from "../../shared/model";
import { lookupOptions } from "../src/views/lookups";
import { changeFieldType, deleteField, deleteObject, renameField } from "../src/workspace/docOps";
import { autoLayout } from "../src/forms/formLayout";

const base = buildTemplate("contacts");
const customers = base.tables.find((t) => t.name === "Customers")!;
const orders = base.tables.find((t) => t.name === "Orders")!;
const lookup: FieldLookup = { display: "combo", rowSourceType: "table", rowSource: customers.id, boundColumn: "CustomerID", displayColumn: "LastName" };
const withLookup = produce(base, (d) => {
  d.tables.find((t) => t.id === orders.id)!.fields.find((f) => f.name === "CustomerID")!.lookup = lookup;
});
const lookupOf = (doc: typeof base) => doc.tables.find((t) => t.id === orders.id)!.fields.find((f) => f.name === "CustomerID")!.lookup;

describe("lookup fields", () => {
  it("are valid in a saved document", () => {
    expect(() => projectDocSchema.parse(withLookup)).not.toThrow();
  });

  it("list the bound value with the display value, sorted by what's shown", async () => {
    const opts = await lookupOptions(withLookup, lookup);
    expect(opts.length).toBe(customers.rows.length);
    expect(opts.map((o) => o.label)).toEqual([...opts.map((o) => o.label)].sort((a, b) => a.localeCompare(b)));
    const ada = customers.rows.find((r) => r.c_last === "Lovelace")!;
    expect(opts.find((o) => o.label === "Lovelace")!.value).toBe(String(ada.c_id));
    const values = await lookupOptions(withLookup, { display: "combo", rowSourceType: "values", rowSource: '"Red";"Green"\nBlue' });
    expect(values.map((o) => o.value)).toEqual(["Red", "Green", "Blue"]); // typed order, like Access
  });

  it("follow renamed and deleted fields and tables", () => {
    const renamed = produce(withLookup, (d) => renameField(d, d.tables.find((t) => t.id === customers.id)!, "c_last", "Surname"));
    expect(lookupOf(renamed)!.displayColumn).toBe("Surname");
    const fieldGone = produce(withLookup, (d) => deleteField(d, d.tables.find((t) => t.id === customers.id)!, "c_last"));
    expect(lookupOf(fieldGone)).toMatchObject({ rowSource: customers.id, boundColumn: "CustomerID" });
    expect(lookupOf(fieldGone)!.displayColumn).toBeUndefined();
    const tableGone = produce(withLookup, (d) => deleteObject(d, "table", customers.id));
    expect(lookupOf(tableGone)).toBeUndefined();
  });

  it("stay when the field changes to another type that can have one", () => {
    const toText = produce(withLookup, (d) => void changeFieldType(d.tables.find((t) => t.id === orders.id)!, "o_cust", "ShortText"));
    expect(lookupOf(toText)).toEqual(lookup);
    const toDate = produce(withLookup, (d) => void changeFieldType(d.tables.find((t) => t.id === orders.id)!, "o_cust", "DateTime"));
    expect(lookupOf(toDate)).toBeUndefined();
  });

  it("become combo boxes on generated forms", () => {
    const t = withLookup.tables.find((x) => x.id === orders.id)!;
    const layout = autoLayout("Orders", t.fields.map((f) => ({ name: f.name, field: f })));
    const combo = layout.controls.find((c) => c.field === "CustomerID")!;
    expect(combo).toMatchObject({ type: "combobox", rowSourceType: "table", rowSource: customers.id, boundColumn: "CustomerID", displayColumn: "LastName" });
  });
});
