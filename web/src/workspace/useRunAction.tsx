import type { QueryDef } from "../../../shared/model";
import { planAction } from "../engine/actions";
import { loadLinkedTables } from "../engine/linked";
import { isActionType } from "../engine/statements";
import { useDialogs } from "../ui/dialogs";
import { useWorkspace } from "./context";
import { typeOfQuery } from "./queryKinds";

/**
 * Runs an action query the way Access does: say what it will change, list any records it
 * has to skip, ask to continue, then apply everything as one step (Ctrl+Z undoes it).
 * Returns false for select and crosstab queries, which callers show in Datasheet View instead.
 */
export function useRunAction() {
  const ws = useWorkspace();
  const dialogs = useDialogs();

  return async function runAction(query: QueryDef, sql = query.sql): Promise<boolean> {
    if (!isActionType(typeOfQuery({ ...query, sql, mode: "sql" }))) return false;
    if (ws.readOnly) {
      ws.setStatus("You have view-only access, so action queries can't change this database.", "error");
      return true;
    }
    ws.setStatus(`Running ${query.name}…`);
    let plan;
    try {
      const { tables } = await loadLinkedTables(ws.doc, ws.projectId, sql);
      plan = await planAction(ws.doc, sql, query.id, tables);
    } catch (e) {
      ws.setStatus("");
      await dialogs.alert("Microsoft Access Web", (e as Error).message);
      return true;
    }
    ws.setStatus("");
    if (plan.count === 0 && !plan.problems.length && plan.kind !== "makeTable") {
      await dialogs.alert("Microsoft Access Web", "The query didn't find any records to change.");
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
      await dialogs.alert("Microsoft Access Web", (e as Error).message);
    }
    return true;
  };
}
