import { describe, expect, it } from "vitest";
import { buildTemplate } from "../../shared/templates";
import { fillTemplate, LABEL_PRESETS, layoutProblem, linkKeyField, recordLink } from "../src/reports/labels";
import { labelLayoutSchema } from "../../shared/model";

describe("labels", () => {
  it("every preset fits its page", () => {
    for (const p of LABEL_PRESETS) {
      const l = labelLayoutSchema.parse({ ...p.layout, preset: p.id, padding: 0.1, align: "center", lines: [] });
      expect(layoutProblem(l), p.id).toBeNull();
    }
  });

  it("catches labels that run off the page", () => {
    const l = labelLayoutSchema.parse({ ...LABEL_PRESETS[0].layout, across: 3, padding: 0.1, align: "left", lines: [] });
    expect(layoutProblem(l)).toMatch(/wider than/);
  });

  it("fills field names, any case, and flags unknown ones", () => {
    expect(fillTemplate("[firstname] [LastName] – [Nope]", ["FirstName", "LastName"], [undefined, undefined], ["Ada", "Lovelace"])).toBe("Ada Lovelace – #Name?");
  });

  it("links to a record by the table's key", () => {
    const doc = buildTemplate("contacts");
    const t = doc.tables[0];
    const key = linkKeyField(doc, { kind: "table", id: t.id });
    expect(key).toBe(t.fields.find((f) => f.primaryKey)!.name);
    const url = new URL(recordLink("https://example.org/", "p1", { kind: "table", id: t.id }, key!, 42));
    expect(url.searchParams.get("db")).toBe("p1");
    expect(url.searchParams.get("open")).toBe(`table:${t.id}`);
    expect(url.searchParams.get("rec")).toBe("42");
  });
});
