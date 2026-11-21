/**
 * The AI assistant's allowance in its dialogs: free requests left (without the plan) or today's
 * (with it), and, once the free ones are used up, the way to the plan.
 */
import { useEffect, useState } from "react";
import type { AiStatus } from "../../../shared/ai";
import { PLAN_NAME } from "../../../shared/plans";
import { api } from "../api";

export function useAiStatus() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  useEffect(() => {
    api.aiStatus().then(setStatus, () => undefined);
  }, []);
  /** After a request: what's left now. */
  const update = (r: { remaining: number; free?: AiStatus["free"] }) =>
    setStatus((s) => (s ? { ...s, remaining: r.remaining, free: r.free ?? s.free, available: r.remaining > 0, upgrade: !!r.free && r.free.left <= 0 && !s.included } : s));
  return [status, update] as const;
}

export const openPlan = (message?: string) => window.dispatchEvent(new CustomEvent("accessweb:upgrade", { detail: { error: message, feature: "ai", yours: true } }));

/** One line for the bottom of the dialog. */
export function allowanceText(s: AiStatus | null): string {
  if (!s?.configured) return "";
  if (s.free && !s.included) {
    const { left, total, monthly } = s.free;
    if (left <= 0) return ` You've used your free AI requests${monthly ? " for this month" : ""}.`;
    return ` ${left} of ${total} free AI request${total === 1 ? "" : "s"} left${monthly ? " this month" : ""}; the ${PLAN_NAME} plan includes the assistant.`;
  }
  return s.remaining !== undefined ? ` ${s.remaining} AI request${s.remaining === 1 ? "" : "s"} left today.` : "";
}

/** Shown in place of the error when the free requests are used up (or the assistant isn't available). */
export function Unavailable({ status }: { status: AiStatus }) {
  return (
    <div className="ai-error" role="alert">
      {status.reason ?? "The AI assistant isn't available."}
      {status.upgrade && (
        <>
          {" "}
          <button className="link" onClick={() => openPlan(status.reason)}>
            See the {PLAN_NAME} plan
          </button>
        </>
      )}
    </div>
  );
}
