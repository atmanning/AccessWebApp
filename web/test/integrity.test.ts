import { describe, expect, it } from "vitest";
import { buildTemplate } from "../../shared/templates";
import type { ProjectDoc } from "../../shared/model";
import { applyCascadeDeletes, applyKeyChange, describeCascades, planDelete, planKeyChange } from "../src/engine/integrity";

function setup(opts: { cascadeUpdate?: boolean; cascadeDelete?: boolean } = {}) {
  const doc = buildTemplate("contacts") as ProjectDoc;
  const customers = doc.tables.find((t) => t.name === "Customers")!;
  const orders = doc.tables.find((t) => t.name === "Orders")!;
  const rel = doc.relationships.find((r) => r.fromTable === customers.id && r.toTable === orders.id)!;
  rel.enforce = true;
  Object.assign(rel, opts);
  const cid = customers.fields.find((f) => f.name === "CustomerID")!.id;
  const ocid = orders.fields.find((f) => f.name === "CustomerID")!.id;
  return { doc, customers, orders, rel, cid, ocid };
}

describe("referential integrity with cascades", () => {
  it("refuses a key change that related records use, without Cascade Update", () => {
    const { doc, customers, cid } = setup();
    expect(planKeyChange(doc, customers.id, cid, 1, 100).blockedBy).toBe("Orders");
    // A key nobody uses can change.
    const unused = customers.rows.find((r) => !doc.tables.find((t) => t.name === "Orders")!.rows.some((o) => Object.values(o).includes(r[cid])));
    if (unused) expect(planKeyChange(doc, customers.id, cid, unused[cid], 999).blockedBy).toBeUndefined();
  });

  it("carries a key change to related records with Cascade Update", () => {
    const { doc, customers, orders, cid, ocid } = setup({ cascadeUpdate: true });
    const before = orders.rows.filter((o) => o[ocid] === 1).length;
    const plan = planKeyChange(doc, customers.id, cid, 1, 100);
    expect(plan.blockedBy).toBeUndefined();
    expect(plan.updates[0].rowIds).toHaveLength(before);
    applyKeyChange(doc, plan, 100);
    expect(orders.rows.filter((o) => o[ocid] === 100)).toHaveLength(before);
    expect(orders.rows.filter((o) => o[ocid] === 1)).toHaveLength(0);
  });

  it("refuses deleting a record with related records, without Cascade Delete", () => {
    const { doc, customers } = setup({ cascadeUpdate: true });
    expect(planDelete(doc, customers.id, [customers.rows[0]._id as string]).blockedBy).toBe("Orders");
  });

  it("deletes related records too with Cascade Delete, following chains", () => {
    const { doc, customers, orders, ocid, cid } = setup({ cascadeDelete: true });
    // Add a third level: Notes on Orders, also cascading.
    const oid = orders.fields.find((f) => f.name === "OrderID")!.id;
    doc.tables.push({ ...orders, id: "t_notes", name: "Notes", fields: [{ ...orders.fields[0], id: "n_id", name: "NoteID" }, { ...orders.fields[0], id: "n_oid", name: "OrderID", type: "Number", primaryKey: false }], rows: orders.rows.map((o, i) => ({ _id: `n${i}`, n_id: i + 1, n_oid: o[oid] })) } as never);
    doc.relationships.push({ id: "rel_n", fromTable: orders.id, fromField: oid, toTable: "t_notes", toField: "n_oid", enforce: true, cascadeDelete: true });
    const ada = customers.rows.find((r) => r[cid] === 1)!;
    const adaOrders = orders.rows.filter((o) => o[ocid] === 1).length;
    const plan = planDelete(doc, customers.id, [ada._id as string]);
    expect(plan.blockedBy).toBeUndefined();
    expect(plan.cascades.get(orders.id)?.size).toBe(adaOrders);
    expect(plan.cascades.get("t_notes")?.size).toBe(adaOrders);
    expect(describeCascades(doc, plan)).toBe(`${adaOrders} in Orders and ${adaOrders} in Notes`);
    applyCascadeDeletes(doc, plan);
    expect(orders.rows.some((o) => o[ocid] === 1)).toBe(false);
  });

  it("stops at a link further down that doesn't cascade", () => {
    const { doc, customers, orders, cid } = setup({ cascadeDelete: true });
    const oid = orders.fields.find((f) => f.name === "OrderID")!.id;
    doc.tables.push({ ...orders, id: "t_lines", name: "Lines", fields: [{ ...orders.fields[0], id: "l_oid", name: "OrderID", type: "Number", primaryKey: false }], rows: orders.rows.map((o, i) => ({ _id: `l${i}`, l_oid: o[oid] })) } as never);
    doc.relationships.push({ id: "rel_l", fromTable: orders.id, fromField: oid, toTable: "t_lines", toField: "l_oid", enforce: true });
    const ada = customers.rows.find((r) => r[cid] === 1)!;
    expect(planDelete(doc, customers.id, [ada._id as string]).blockedBy).toBe("Lines");
  });
});
