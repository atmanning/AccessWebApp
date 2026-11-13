/**
 * Calculated controls (Control Source "=…"): their values for a record, worked out from the
 * record's fields, the form's other controls, the form's records (Sum, Count…) and the
 * database's tables (DLookup, DCount…).
 */
import type { CellValue, FormControl, FormLayout, ProjectDoc } from "../../../shared/model";
import { compileExpression, displayValue, evaluate, ExprError, isExpression, rowContext, toExpr, type ExprContext, type ExprValue } from "../engine/expr";

export interface CalcResult {
  text: string;
  value: ExprValue;
  /** Why it couldn't be worked out (the text is then #Name? or #Error). */
  error?: string;
}

export interface FormCalc {
  /** A calculated control's value for one record, with the form's records for totals. */
  value(c: FormControl, row: readonly CellValue[] | null, records: () => readonly (readonly CellValue[])[]): CalcResult;
  /** An expression (without its control) for one record: used by the Expression Builder's preview. */
  preview(expression: string, row: readonly CellValue[] | null, records: () => readonly (readonly CellValue[])[], format?: string): CalcResult;
}

export function makeFormCalc(doc: ProjectDoc, layout: FormLayout, columns: string[]): FormCalc {
  const tableRows = new Map<string, ExprContext[]>();
  const domain = (name: string): ExprContext[] | undefined => {
    const key = name.toLowerCase();
    const hit = tableRows.get(key);
    if (hit) return hit;
    const t = doc.tables.find((x) => x.name.toLowerCase() === key);
    if (!t) return undefined;
    const names = t.fields.map((f) => f.name);
    const rows = t.rows.map((r) => rowContext(names, t.fields.map((f) => r[f.id] ?? null)));
    tableRows.set(key, rows);
    return rows;
  };
  const controls = new Map(layout.controls.map((c) => [c.name.toLowerCase(), c]));

  const contextFor = (row: readonly CellValue[] | null, records: () => readonly (readonly CellValue[])[], visiting: Set<string>): ExprContext => {
    const ctx: ExprContext = rowContext(columns, row, {
      domain,
      records: () => records().map((r) => contextFor(r, records, visiting)),
      // Not a field: another control on the form, by its name.
      lookup: (name) => {
        const c = controls.get(name.toLowerCase());
        if (!c?.field) return undefined;
        if (!isExpression(c.field)) return ctx.lookup(c.field);
        if (visiting.has(c.id)) throw new ExprError(`${c.name} refers to itself.`);
        const compiled = compileExpression(c.field);
        if (!compiled.ok) throw new ExprError(`${c.name}'s expression has a problem: ${compiled.error}`);
        visiting.add(c.id);
        try {
          return evaluate(compiled.node, ctx);
        } finally {
          visiting.delete(c.id);
        }
      },
    });
    return ctx;
  };

  const run = (expression: string, row: readonly CellValue[] | null, records: () => readonly (readonly CellValue[])[], format: string | undefined, self?: string): CalcResult => {
    const compiled = compileExpression(expression);
    if (!compiled.ok) return { text: "#Error", value: null, error: compiled.error };
    try {
      const value = evaluate(compiled.node, contextFor(row, records, new Set(self ? [self] : [])));
      return { text: displayValue(value, format), value };
    } catch (e) {
      if (e instanceof ExprError) return { text: e.display, value: null, error: e.message };
      return { text: "#Error", value: null, error: (e as Error).message };
    }
  };

  return {
    value: (c, row, records) => run(c.field ?? "", row, records, c.format, c.id),
    preview: (expression, row, records, format) => run(expression, row, records, format),
  };
}

export { isExpression, toExpr };
