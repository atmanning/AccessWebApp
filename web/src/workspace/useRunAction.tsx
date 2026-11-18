import type { QueryDef } from "../../../shared/model";
import { planAction } from "../engine/actions";
import { loadLinkedTables } from "../engine/linked";
import { isActionType } from "../engine/statements";
import { useDialogs } from "../ui/dialogs";
import { useWorkspace } from "./context";
import { typeOfQuery } from "./queryKinds";
import { freezeReferences } from "../macros/runMacro";
import { makeFormCalc } from "../forms/formCalc";

/**
 * Runs an action query the way Access does: say what it will change, list any records it
 * has to skip, ask to continue, then apply everything as one step (Ctrl+Z undoes it).
 * Returns false for select and crosstab queries, which callers show in Datasheet View instead.
 */
export function useRunAction() {
  const ws = useWorkspace();
  const dialogs = useDialogs();

  /**
   * `warnings: false` (a macro after SetWarnings No) runs it without asking or reporting;
   * `throwErrors` hands errors to the caller (a macro's OnError) instead of showing them.
   */
  return async function runAction(query: QueryDef, sql = query.sql, opts: { warnings?: boolean; throwErrors?: boolean } = {}): Promise<boolean> {
    if (!isActionType(typeOfQuery({ ...query, sql, mode: "sql" }))) return false;
    const warnings = opts.warnings !== false;
    const fail = async (message: string) => {
      if (opts.throwErrors) throw new Error(message);
      await dialogs.alert("Microsoft Access Web", message);
    };
    if (ws.readOnly) {
      if (opts.throwErrors) throw new Error("You have view-only access, so action queries can't change this database.");
      ws.setStatus("You have view-only access, so action queries can't change this database.", "error");
      return true;
    }
    // The latest document: an earlier action in the same macro may have just changed it.
    const doc = ws.getDoc();
    // [Forms]![Project Details]![ID] in the SQL: the value on that open form now.
    sql = freezeReferences(sql, (e) => makeFormCalc(doc, { controls: [] }, []).evaluate(e, null, () => []));
    ws.setStatus(`Running ${query.name}…`);
    let plan;
    try {
      const { tables } = await loadLinkedTables(doc, ws.projectId, sql);
      plan = await planAction(doc, sql, query.id || undefined, tables);
    } catch (e) {
      ws.setStatus("");
      await fail((e as Error).message);
      return true;
    }
    ws.setStatus("");
    if (plan.count === 0 && !plan.problems.length && plan.kind !== "makeTable") {
      if (warnings) await dialogs.alert("Microsoft Access Web", "There's nothing to change: no records match this query.");
      return true;
    }
    if (!warnings) {
      try {
        ws.update(plan.apply);
        ws.setStatus(plan.done);
      } catch (e) {
        await fail((e as Error).message);
      }
      return true;
    }
    const ok = await dialogs.confirm(
      "Microsoft Access Web",
      <>
        {plan.replaces && <p>{plan.replaces}</p>}
        <p>{plan.confirm}</p>
        {plan.problems.length > 0 && (
          <>
            <p>Some records can't be changed:</p>
            <ul className="plan-problems">
              {plan.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </>
        )}
        <p>Do you want to continue? You can undo this with Ctrl+Z.</p>
      </>,
      { okLabel: "Yes" },
    );
    if (!ok) return true;
    try {
      ws.update(plan.apply);
      ws.setStatus(plan.done);
    } catch (e) {
      await fail((e as Error).message);
    }
    return true;
  };
}
