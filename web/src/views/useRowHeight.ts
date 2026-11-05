/** Datasheet row height (drag a row edge, or Home → Row Height), saved with the table or query. */
import { useState } from "react";
import { useDialogs } from "../ui/dialogs";
import { useWorkspace } from "../workspace/context";
import { MAX_ROW_H, MIN_ROW_H } from "./Datasheet";

export function useRowHeight(saved: number | undefined, persist: (height: number | undefined) => void) {
  const ws = useWorkspace();
  const dialogs = useDialogs();
  // View-only users can still change it for this visit.
  const [viewerRowH, setViewerRowH] = useState<number | undefined | null>(null);
  const rowHeight = ws.readOnly && viewerRowH !== null ? viewerRowH : saved;
  const saveRowHeight = (h: number | undefined) => (ws.readOnly ? setViewerRowH(h) : persist(h));
  const askRowHeight = async () => {
    const v = await dialogs.prompt(
      "Row Height",
      `Row Height in pixels (${MIN_ROW_H}–${MAX_ROW_H}). Leave it blank for the standard height.`,
      rowHeight ? String(rowHeight) : "",
      (t) => {
        if (!t.trim()) return null;
        const n = Number(t);
        return Number.isInteger(n) && n >= MIN_ROW_H && n <= MAX_ROW_H ? null : `Enter a whole number from ${MIN_ROW_H} to ${MAX_ROW_H}.`;
      },
    );
    if (v !== null) saveRowHeight(v.trim() ? Number(v) : undefined);
  };
  return { rowHeight, saveRowHeight, askRowHeight };
}
