import { describe, expect, it } from "vitest";
import type { TableDef } from "../../shared/model";
import { combinationError, firstDuplicate, uniqueCombinations } from "../src/engine/combos";

const table = (opts: { pk?: boolean; index?: boolean }): TableDef => ({
  id: "t",
  name: "Breeds",
  nextAutoNumber: 4,
  fields: [
    { id: "id", name: "BreedID", type: "AutoNumber", primaryKey: !opts.pk },
    { id: "pt", name: "PetType", type: "ShortText", primaryKey: !!opts.pk },
    { id: "br", name: "Breed", type: "ShortText", primaryKey: !!opts.pk },
  ] as TableDef["fields"],
  rows: [
    { _id: "a", id: 1, pt: "Dog", br: "Beagle" },
    { _id: "b", id: 2, pt: "Cat", br: "Siamese" },
    { _id: "c", id: 3, pt: "Dog", br: null },
  ],
  indexes: opts.index ? [{ id: "ix", name: "PetBreed", fields: ["pt", "br"], unique: true }] : undefined,
});

describe("combination keys", () => {
  for (const kind of ["unique index", "two-field primary key"]) {
    it(`refuses a repeated combination (${kind})`, () => {
      const t = table(kind === "unique index" ? { index: true } : { pk: true });
      expect(uniqueCombinations(t)).toHaveLength(1);
      // Same combination (any capitals): refused.
      expect(combinationError(t, { _id: "", id: 9, pt: "dog", br: "BEAGLE" }, "new")).toMatch(/combination of PetType and Breed must be unique, and "dog" \+ "BEAGLE" is already used/);
      // Each value on its own may repeat.
      expect(combinationError(t, { _id: "", id: 9, pt: "Dog", br: "Poodle" }, "new")).toBeNull();
      expect(combinationError(t, { _id: "", id: 9, pt: "Cat", br: "Beagle" }, "new")).toBeNull();
      // Changing a record to its own combination is fine.
      expect(combinationError(t, { ...t.rows[0] }, 0)).toBeNull();
      // Not checked until every part has a value.
      expect(combinationError(t, { _id: "", id: 9, pt: "Dog", br: null }, "new")).toBeNull();
    });
  }

  it("finds duplicates already in the data before making an index unique", () => {
    const t = table({});
    expect(firstDuplicate(t, t.fields.slice(1))).toBeNull();
    t.rows.push({ _id: "d", id: 4, pt: "DOG", br: "beagle" });
    expect(firstDuplicate(t, t.fields.slice(1))).toBe('"DOG" + "beagle"');
  });
});
