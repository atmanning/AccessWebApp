/**
 * "Your plan": Free and Advanced side by side, what this person can use, and Upgrade (Stripe
 * Checkout) or Manage billing (Stripe's portal). Opened from Home, and by itself when the server
 * refuses an advanced feature (the "accessweb:upgrade" event).
 */
import { useEffect, useState } from "react";
import { FEATURES, FEATURE_IDS, PLAN_INCLUDES, PLAN_NAME, type BillingStatus, type FeatureId } from "../../../shared/plans";
import { api } from "../api";
import { Modal } from "../ui/dialogs";
import "./plans.css";

export interface PlanReason {
  feature?: FeatureId;
  message?: string;
  /** The database's owner (someone else) would need the plan. */
  notYours?: boolean;
  /** Just came back from Stripe: "done" (subscribed), "cancelled", "portal". */
  returned?: "done" | "cancelled" | "portal";
}

/** Where Stripe sends people back to: here, without the billing parameters. */
export function currentPlace() {
  const u = new URL(location.href);
  u.searchParams.delete("billing");
  u.searchParams.delete("session_id");
  return u.pathname + (u.search || "");
}

export function PlanDialog({ reason, onClose, initial }: { reason?: PlanReason; onClose: () => void; initial?: BillingStatus }) {
  const [s, setS] = useState<BillingStatus | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"upgrade" | "manage" | null>(null);

  useEffect(() => {
    if (!initial) api.billingStatus().then(setS, (e) => setError(e.message));
  }, [initial]);

  const go = async (kind: "upgrade" | "manage") => {
    setBusy(kind);
    setError(null);
    try {
      const { url } = kind === "upgrade" ? await api.checkout(currentPlace()) : await api.billingPortal(currentPlace());
      location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const onPlan = !!s?.plan && PLAN_INCLUDES.has(s.plan.status);
  const advanced = s?.advanced ?? [];
  const granted = new Set(s?.granted ?? []);
  const free = FEATURE_IDS.filter((f) => !advanced.includes(f));
  const showPlans = !!s && s.gated && advanced.length > 0;

  return (
    <Modal
      title="Your plan"
      onClose={onClose}
      width={620}
      footer={
        <>
          {s && s.plan && s.billing && (
            <button onClick={() => void go("manage")} disabled={!!busy}>
              {busy === "manage" ? "Opening…" : "Manage billing"}
            </button>
          )}
          <span className="spacer" />
          {showPlans && !onPlan && !s.admin && s.billing && (
            <button className="primary" onClick={() => void go("upgrade")} disabled={!!busy}>
              {busy === "upgrade" ? "Opening Stripe…" : `Upgrade to ${PLAN_NAME}${s.price ? ` · ${s.price}` : ""}`}
            </button>
          )}
          <button onClick={onClose}>Close</button>
        </>
      }
    >
      <div className="plan">
        {reason?.returned === "done" && onPlan && (
          <div className="plan-banner ok" role="status">
            <strong>You're on the {PLAN_NAME} plan.</strong> Thank you! Everything below is ready to use.
          </div>
        )}
        {reason?.returned === "cancelled" && <div className="plan-banner">Checkout was cancelled, so nothing changed and you weren't charged.</div>}
        {reason?.message && !reason.returned && (
          <div className="plan-banner warn" role="alert">
            {reason.message}
            {reason.notYours && <div className="small">Ask the database's owner to upgrade, or the site's administrator to turn it on for them.</div>}
          </div>
        )}
        {error && <div className="field-error">{error}</div>}
        {!s ? (
          !error && <p className="muted">Loading…</p>
        ) : !showPlans ? (
          <p>
            <strong>Every feature is available to everyone right now.</strong> <span className="muted">There's nothing you need to do.</span>
          </p>
        ) : (
          <>
            <p className="plan-now">
              You're on <strong>{s.admin ? "the admin account (everything included)" : onPlan ? `the ${PLAN_NAME} plan` : "the Free plan"}</strong>
              {onPlan && s.plan?.renewsAt && (
                <span className="muted">
                  {" "}
                  · {s.plan.cancelAtPeriodEnd ? "ends" : "renews"} {new Date(s.plan.renewsAt).toLocaleDateString([], { dateStyle: "medium" })}
                </span>
              )}
              {s.plan?.status === "past_due" && <span className="plan-warn"> · your last payment didn't go through; please update your card in Manage billing</span>}
            </p>
            <div className="plan-cols">
              <div className={`plan-col ${!onPlan && !s.admin ? "current" : ""}`}>
                <div className="plan-col-head">
                  Free <span className="muted small">$0</span>
                  {!onPlan && !s.admin && <span className="plan-tag">Current</span>}
                </div>
                <ul>
                  <li className="yes">Unlimited tables, queries, forms and reports</li>
                  <li className="yes">Labels, name tags and the scan station</li>
                  {free.map((f) => (
                    <li key={f} className="yes">
                      {FEATURES[f].name}
                    </li>
                  ))}
                  {advanced.map((f) => (
                    <li key={f} className={granted.has(f) ? "yes" : "no"}>
                      {FEATURES[f].name}
                      {granted.has(f) && <span className="plan-tag">turned on for you</span>}
                    </li>
                  ))}
                </ul>
              </div>
              <div className={`plan-col adv ${onPlan ? "current" : ""}`}>
                <div className="plan-col-head">
                  {PLAN_NAME} <span className="muted small">{s.price ?? ""}</span>
                  {onPlan && <span className="plan-tag">Current</span>}
                </div>
                <ul>
                  <li className="yes">Everything in Free, plus:</li>
                  {advanced.map((f) => (
                    <li key={f} className={`yes ${reason?.feature === f ? "wanted" : ""}`}>
                      <strong>{FEATURES[f].name}</strong>
                      <div className="small muted">{FEATURES[f].description}</div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            {!onPlan && !s.admin && !s.billing && (
              <p className="small muted">Upgrading online isn't set up on this site yet. Ask the site's administrator to turn on the features you need.</p>
            )}
            {!onPlan && !s.admin && s.billing && s.price?.startsWith("$0.00") && (
              <p className="small muted">The {PLAN_NAME} plan is free while we're testing: no card is needed.</p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
