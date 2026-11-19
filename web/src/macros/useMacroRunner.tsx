/** Runs macros in the workspace: opens objects, asks before RunSQL, shows MessageBox… */
import { useRef } from "react";
import type { MacroStep } from "../../../shared/macros";
import type { ExprValue } from "../engine/expr";
import { makeFormCalc } from "../forms/formCalc";
import { useDialogs } from "../ui/dialogs";
import { tabKey, useWorkspace } from "../workspace/context";
import { useRunAction } from "../workspace/useRunAction";
import { runMacro, type MacroEnv, type MacroResult } from "./runMacro";
import { formSessions, type FormHandle } from "./runtime";

let audio: AudioContext | null = null;
export function beep() {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 880;
    g.gain.value = 0.08;
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.12);
  } catch {
    // No sound available.
  }
}

const ICONS: Record<string, string> = { critical: "⛔ ", "warning?": "❓ ", "warning!": "⚠️ ", information: "ℹ️ " };

/** Returns run(steps, form?): runs a macro, as the form's event or on its own (Navigation Pane, AutoExec). */
export function useMacroRunner() {
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const runAction = useRunAction();
  // Handlers read the latest workspace and dialogs, also after awaits.
  const live = useRef({ ws, dialogs, runAction });
  live.current = { ws, dialogs, runAction };

  return async function run(steps: readonly MacroStep[], form?: FormHandle, opts: { quiet?: boolean; activeControl?: string } = {}): Promise<MacroResult> {
    const L = () => live.current;
    const env: MacroEnv = {
      form,
      quietErrors: opts.quiet,
      activeControl: opts.activeControl,
      evaluate: (e: string): ExprValue => (form ? form.evaluate(e) : makeFormCalc(L().ws.getDoc(), { controls: [] }, []).evaluate(e, null, () => [])),
      doc: () => L().ws.getDoc(),
      open: (kind, id, view, opts) => {
        const how = opts.where || opts.dataMode || opts.print || opts.openArgs ? opts : undefined;
        L().ws.openObject(kind, id, view, undefined, how);
      },
      close: (kind, id) => L().ws.closeTab(tabKey(kind, id)),
      closeAll: () => L().ws.closeAll(),
      runSql: async (sql, warnings) => {
        const ran = await L().runAction({ id: "", name: "RunSQL", sql, mode: "sql" } as never, sql, { warnings, throwErrors: true });
        if (!ran) throw new Error("RunSQL runs action queries (INSERT INTO, UPDATE, DELETE, SELECT … INTO). Use OpenQuery or OpenForm to show records.");
      },
      runActionQuery: async (id, warnings) => {
        const q = L().ws.getDoc().queries.find((x) => x.id === id);
        return q ? L().runAction(q, q.sql, { warnings, throwErrors: true }) : false;
      },
      message: (text, title, type) => L().dialogs.alert(title || "Microsoft Access Web", `${ICONS[type.toLowerCase()] ?? ""}${text}`),
      ask: async (text, title, buttons) => {
        const kind = buttons & 7;
        const icon = ICONS[(buttons & 0x70) === 16 ? "critical" : (buttons & 0x70) === 32 ? "warning?" : (buttons & 0x70) === 48 ? "warning!" : (buttons & 0x70) === 64 ? "information" : ""] ?? "";
        if (kind === 0) {
          await L().dialogs.alert(title || "Microsoft Access Web", `${icon}${text}`);
          return 1;
        }
        const yesNo = kind === 3 || kind === 4;
        const ok = await L().dialogs.confirm(title || "Microsoft Access Web", `${icon}${text}`, { okLabel: yesNo ? "Yes" : kind === 5 ? "Retry" : "OK", cancelLabel: yesNo ? "No" : undefined });
        return yesNo ? (ok ? 6 : 7) : kind === 5 ? (ok ? 4 : 2) : ok ? 1 : 2;
      },
      status: (text, kind) => L().ws.setStatus(text, kind),
      beep,
      print: () => window.print(),
      openUrl: (url) => {
        // mailto: and tel: go to the mail or phone app; web pages open in a new tab.
        const a = document.createElement("a");
        a.href = url;
        if (/^https?:/i.test(url)) {
          a.target = "_blank";
          a.rel = "noopener noreferrer";
        }
        document.body.appendChild(a);
        a.click();
        a.remove();
      },
      waitClosed: (kind, id) =>
        new Promise<void>((resolve) => {
          const key = tabKey(kind, id);
          const started = Date.now();
          let seen = false;
          const tick = () => {
            if (formSessions.has(key)) seen = true;
            // Closed again (or never opened): go on.
            if ((seen && !formSessions.has(key)) || (!seen && Date.now() - started > 3000)) return resolve();
            setTimeout(tick, 250);
          };
          tick();
        }),
      download: (name, mime, text) => {
        const url = URL.createObjectURL(new Blob([text], { type: mime }));
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      },
    };
    const r = await runMacro(steps, env);
    if (!r.ok && r.error) L().ws.setStatus(`The macro stopped: ${r.error}`, "error");
    return r;
  };
}
