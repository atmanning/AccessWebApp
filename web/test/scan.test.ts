import { describe, expect, it } from "vitest";
import { buildTemplate } from "../../shared/templates";
import type { ProjectDoc, ScanAction } from "../../shared/model";
import { applyScan, keyFromScan, makeLogTable, undoScan } from "../src/scan/scanActions";
import { fieldsCompatible } from "../src/engine/integrity";

const setup = () => {
  const doc = buildTemplate("contacts") as ProjectDoc;
  const people = doc.tables.find((t) => t.name === "Customers")!;
  return { doc, people };
};

describe("scan station", () => {
  it("reads the person's key from a tag's link, a record link, or typed text", () => {
    expect(keyFromScan("https://x.onrender.com/r/AbCdEfGhIjKlMnOpQr?key=CustomerID&rec=42")).toBe("42");
    expect(keyFromScan("https://x.onrender.com/?db=p1&open=form:f&key=CustomerID&rec=7")).toBe("7");
    expect(keyFromScan(" 15 ")).toBe("15");
    expect(keyFromScan("https://example.com/no-key")).toBeNull();
  });

  it("logs attendance in a ready-made table, once per person and session, with undo", () => {
    const { doc, people } = setup();
    const { table, action } = makeLogTable(doc, people, "Attendance", "Session");
    const whatId = table.fields[3].id;
    const a: ScanAction = { ...action, id: "a1", name: "Attended: Session 2", values: { [whatId]: "Session 2" } };
    // The person field matches the key's type, so the relationship holds.
    const rel = doc.relationships.find((r) => r.toTable === table.id)!;
    expect(fieldsCompatible(people.fields.find((f) => f.id === rel.fromField)!, table.fields.find((f) => f.id === rel.toField)!)).toBe(true);

    const r1 = applyScan(doc, a, "1");
    expect(r1).toMatchObject({ ok: true, person: "Ada Lovelace", message: "Added to Attendance: Session 2" });
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0][table.fields[1].id]).toBe(1);
    expect(String(table.rows[0][table.fields[2].id])).toMatch(/^\d{4}-\d\d-\d\dT/);

    expect(applyScan(doc, a, "1")).toMatchObject({ ok: false, already: true });
    // Another session is a separate record.
    expect(applyScan(doc, { ...a, values: { [whatId]: "Session 3" } }, "1").ok).toBe(true);
    expect(applyScan(doc, a, "999")).toMatchObject({ ok: false, message: expect.stringMatching(/no one in Customers with CustomerID 999/) });

    if (r1.ok) undoScan(doc, r1.undo);
    expect(table.rows).toHaveLength(1);
  });

  it("marks a field on the person (an achievement), once", () => {
    const { doc, people } = setup();
    people.fields.push({ id: "f_cpr", name: "CPR", type: "YesNo" } as never);
    const a: ScanAction = { id: "a2", name: "Achievement: CPR", people: people.id, kind: "set", field: "f_cpr", value: "Yes", once: true };
    const r = applyScan(doc, a, "2");
    expect(r).toMatchObject({ ok: true, message: "CPR: Yes" });
    expect(people.rows.find((x) => x[people.fields[0].id] === 2)!.f_cpr).toBe(true);
    expect(applyScan(doc, a, "2")).toMatchObject({ ok: false, already: true });
    if (r.ok) undoScan(doc, r.undo);
    expect(applyScan(doc, a, "2").ok).toBe(true);
  });
});
