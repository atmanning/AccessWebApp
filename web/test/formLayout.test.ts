import { describe, expect, it } from "vitest";
import { formLayoutSchema, formSchema, type Field } from "../../shared/model";
import { autoLayout, layoutOf, parseValueList, readingOrder, syncColumns } from "../src/forms/formLayout";

const f = (name: string, type: Field["type"]): { name: string; field: Field } => ({ name, field: { id: name, name, type } });
const fields = [f("ID", "AutoNumber"), f("First Name", "ShortText"), f("Notes", "LongText"), f("Active", "YesNo")];

describe("form layouts", () => {
  it("generates a layout the server accepts", () => {
    const layout = autoLayout("People", fields);
    expect(formLayoutSchema.safeParse(layout).success).toBe(true);
    const byField = Object.fromEntries(layout.controls.filter((c) => c.field).map((c) => [c.field, c]));
    expect(byField["Active"].type).toBe("checkbox");
    expect(byField["Notes"].multiline).toBe(true);
    expect(byField["ID"].locked).toBe(true);
    // Everything fits inside its section and the form.
    for (const c of layout.controls) {
      expect(c.y + c.h).toBeLessThanOrEqual(layout.sections[c.section]);
      expect(c.x + c.w).toBeLessThanOrEqual(layout.width);
    }
    expect(new Set(layout.controls.map((c) => c.name.toLowerCase())).size).toBe(layout.controls.length);
  });

  it("uses two columns for many fields and keeps long text full width", () => {
    const many = Array.from({ length: 8 }, (_, i) => f(`F${i}`, "ShortText")).concat([f("Memo", "LongText")]);
    const layout = autoLayout("Many", many);
    const xs = new Set(layout.controls.filter((c) => c.section === "detail" && c.field !== "Memo").map((c) => c.x));
    expect(xs.size).toBe(2);
    const memo = layout.controls.find((c) => c.field === "Memo")!;
    expect(memo.w).toBeGreaterThan(500);
  });

  it("gives older forms a layout with stable ids, and keeps columns in step", () => {
    const form = { id: "fm1", name: "F", title: "F", source: { kind: "table" as const, id: "t" }, columns: ["First Name", "Active"] };
    const a = layoutOf(form, fields);
    const b = layoutOf(form, fields);
    expect(a.controls.map((c) => c.id)).toEqual(b.controls.map((c) => c.id));
    const withLayout = { ...form, layout: a };
    withLayout.layout.controls.push({ ...withLayout.layout.controls.find((c) => c.field === "Active")!, id: "dup", name: "Dup" });
    syncColumns(withLayout);
    expect(withLayout.columns).toEqual(["First Name", "Active"]);
    expect(formSchema.safeParse(withLayout).success).toBe(true);
  });

  it("reads value lists and orders controls for tabbing", () => {
    expect(parseValueList('"Red";Green; Blue ;;')).toEqual(["Red", "Green", "Blue"]);
    const layout = autoLayout("P", fields, { style: "columns" });
    const order = readingOrder(layout.controls).map((c) => c.section);
    expect(order[0]).toBe("header");
    expect(order[order.length - 1]).toBe("footer");
  });
});
