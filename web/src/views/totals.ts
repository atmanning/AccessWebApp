/**
 * A datasheet's Total row (Home > Totals, as in Access): which totals a column offers, and working
 * them out over the records shown.
 */
import type { CellValue, FieldType, TotalKind } from "../../../shared/model";

export const TOTAL_LABELS: Record<TotalKind, string> = {
  Sum: "Sum",
  Average: "Average",
  Count: "Count",
  Maximum: "Maximum",
  Minimum: "Minimum",
  StDev: "Standard Deviation",
  Var: "Variance",
};

/** Numbers get every total; dates count, latest and earliest; anything else just a count. */
export function totalsFor(type: FieldType | undefined, numeric: boolean): TotalKind[] {
  if (numeric || type === "Number" || type === "Currency" || type === "AutoNumber") return ["Sum", "Average", "Count", "Maximum", "Minimum", "StDev", "Var"];
  if (type === "DateTime") return ["Count", "Maximum", "Minimum"];
  return ["Count"];
}

/** The column's total over these values (blanks left out, as Access does). */
export function computeTotal(kind: TotalKind, values: CellValue[]): CellValue {
  const filled = values.filter((v) => v !== null && v !== undefined && v !== "");
  if (kind === "Count") return filled.length;
  if (!filled.length) return null;
  if (kind === "Maximum" || kind === "Minimum") {
    const nums = filled.every((v) => typeof v === "number");
    const cmp = (a: CellValue, b: CellValue) => (nums ? (a as number) - (b as number) : String(a).localeCompare(String(b)));
    let best = filled[0];
    for (const v of filled) if (kind === "Maximum" ? cmp(v, best) > 0 : cmp(v, best) < 0) best = v;
    return best;
  }
  const nums = filled.map((v) => (typeof v === "number" ? v : typeof v === "boolean" ? (v ? -1 : 0) : Number(v))).filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  if (kind === "Sum") return round(sum);
  const mean = sum / nums.length;
  if (kind === "Average") return mean;
  if (nums.length < 2) return null;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1);
  return kind === "Var" ? variance : Math.sqrt(variance);
}

/** Adding up decimals leaves float dust (0.1 + 0.2): keep 10 places. */
const round = (n: number) => Math.round(n * 1e10) / 1e10;

/** A calculated column's numbers: whole numbers as they are, others with two decimals. */
export function numericColumn(values: CellValue[]): "whole" | "decimal" | null {
  let any = false;
  let decimal = false;
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    if (typeof v !== "number") return null;
    any = true;
    if (!Number.isInteger(v)) decimal = true;
  }
  return any ? (decimal ? "decimal" : "whole") : null;
}
