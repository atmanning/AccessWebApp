/** Typed values: parsing what people type, formatting for display (shared with the server). */
export * from "../../../shared/values.js";
import type { Field } from "../../../shared/model";

/** A field that must be filled in: Required, or a primary key that isn't an AutoNumber. */
export const isRequiredField = (f?: Field) => !!f && (!!f.required || (!!f.primaryKey && f.type !== "AutoNumber"));
