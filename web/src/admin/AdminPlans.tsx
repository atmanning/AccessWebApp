/**
 * Site admin → Plans: whether advanced features need a plan, which features are advanced, Stripe's
 * set-up, and turning features on or off for the people you choose.
 */
import { useEffect, useMemo, useState } from "react";
import { AI_DEFAULTS, FEATURES, FEATURE_IDS, PLAN_INCLUDES, PLAN_NAME, type AdminPlans as Data, type AdminPlansUser, type AiPlanSettings, type FeatureId } from "../../../shared/plans";
import { api } from "../api";

export function AdminPlans() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [gated, setGated] = useState(false);
  const [advanced, setAdvanced] = useState<FeatureId[]>([]);
  const [ai, setAi] = useState<AiPlanSettings>(AI_DEFAULTS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<Set<FeatureId>>(new Set());
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    api.adminPlans().then(
      (d) => {
        setData(d);
        setGated(d.gated);
        setAdvanced(d.advanced);
        setAi(d.ai);
        setBulk((b) => (b.size ? b : new Set(d.advanced)));
        setError(null);
      },
      (e) => setError(e.message),
    );
  useEffect(() => {
    void load();
  }, []);

  const run = async (f: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      await load();
      setNotice(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const users = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (data?.users ?? []).filter((u) => !t || u.email.toLowerCase().includes(t) || u.name.toLowerCase().includes(t));
  }, [data, q]);

  if (!data) return error ? <div className="field-error">{error}</div> : <p className="muted">Loading…</p>;

  const aiChanged = JSON.stringify(ai) !== JSON.stringify(data.ai);
  const settingsChanged = gated !== data.gated || [...advanced].sort().join() !== [...data.advanced].sort().join() || aiChanged;
  const advSaved = data.advanced;
  const allShown = users.length > 0 && users.every((u) => selected.has(u.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const chosen = [...selected].filter((id) => data.users.some((u) => u.id === id));

  return (
    <>
      <h1>Plans</h1>
      {notice && (
        <div className="admin-notice" role="status">
          {notice}
          <button className="link" onClick={() => setNotice(null)}>
            OK
          </button>
        </div>
      )}
      {error && <div className="field-error">{error}</div>}

      <div className="admin-cards">
        <section className="admin-card">
          <h2>Advanced features</h2>
          <label className="admin-switch">
            <input type="checkbox" checked={gated} onChange={(e) => setGated(e.target.checked)} />
            <span>
              <strong>Require a plan for advanced features</strong>
              <span className="small muted">
                {gated
                  ? ` The features ticked below need the ${PLAN_NAME} plan, or you turning them on for someone. Admins always have everything.`
                  : " Off: everyone can use every feature (the AI assistant has its own rule, below)."}
              </span>
            </span>
          </label>
          <div className="admin-feature-list" aria-label="Which features are advanced">
            {FEATURE_IDS.filter((f) => f !== "ai").map((f) => (
              <label key={f} className={gated ? "" : "muted"}>
                <input type="checkbox" checked={advanced.includes(f)} onChange={(e) => setAdvanced((a) => (e.target.checked ? [...a, f] : a.filter((x) => x !== f)))} />
                <span>
                  <strong>{FEATURES[f].name}</strong>
                  <span className="small muted"> · {FEATURES[f].description}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="small muted">Things people already set up keep working (existing shares, public links, linked MySQL tables); only setting up new ones needs the feature.</p>
          <h3 className="admin-sub">AI assistant</h3>
          <p className="small muted">
            Each request costs the site money, so the assistant is part of the {PLAN_NAME} plan whether or not plans are required. Everyone gets free requests to try it first; you can also turn it on for people below.
          </p>
          <div className="admin-ai">
            <label>
              Free requests without the plan
              <input type="number" min={0} max={100000} value={ai.free} onChange={(e) => setAi({ ...ai, free: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
            </label>
            <label>
              <select value={ai.period} onChange={(e) => setAi({ ...ai, period: e.target.value as AiPlanSettings["period"] })} aria-label="How often the free requests come">
                <option value="once">once, to try it</option>
                <option value="month">every month</option>
              </select>
            </label>
            <label>
              Requests a day with the plan
              <input type="number" min={1} max={100000} value={ai.daily} onChange={(e) => setAi({ ...ai, daily: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
            </label>
          </div>
          <p className="small muted">The daily limit keeps one account from running up the bill. 0 free requests means the assistant is only for the plan.</p>
          <div>
            <button className="primary" disabled={!settingsChanged || busy} onClick={() => void run(() => api.adminPlanSettings(gated, advanced, ai), "Saved. People see the change straight away.")}>
              Save
            </button>
            {settingsChanged && (
              <button className="link admin-undo" onClick={() => (setGated(data.gated), setAdvanced(data.advanced), setAi(data.ai))}>
                Undo changes
              </button>
            )}
          </div>
        </section>

        <StripeCard s={data.stripe} />
      </div>

      <h2>
        People
        <span className="muted admin-count">{data.users.length}</span>
      </h2>
      {!data.gated && <p className="small muted">"Require a plan" is off, so everyone has every feature. You can still turn features on for people now, ready for when you switch it on.</p>}
      <div className="admin-filters">
        <input className="text-input admin-search" type="search" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
      </div>

      {chosen.length > 0 && (
        <div className="admin-bulk" role="region" aria-label="Change features for the selected people">
          <strong>
            {chosen.length} {chosen.length === 1 ? "person" : "people"} selected
          </strong>
          <span className="admin-bulk-features">
            {FEATURE_IDS.map((f) => (
              <label key={f}>
                <input
                  type="checkbox"
                  checked={bulk.has(f)}
                  onChange={(e) =>
                    setBulk((b) => {
                      const n = new Set(b);
                      e.target.checked ? n.add(f) : n.delete(f);
                      return n;
                    })
                  }
                />{" "}
                {FEATURES[f].name}
              </label>
            ))}
          </span>
          <span className="spacer" />
          <button
            className="primary"
            disabled={busy || !bulk.size}
            onClick={() => void run(() => api.adminGrant(chosen, [...bulk], true), `Turned on ${[...bulk].map((f) => FEATURES[f].name).join(", ")} for ${chosen.length} ${chosen.length === 1 ? "person" : "people"}.`)}
          >
            Turn on
          </button>
          <button
            disabled={busy || !bulk.size}
            onClick={() => void run(() => api.adminGrant(chosen, [...bulk], false), `Turned off ${[...bulk].map((f) => FEATURES[f].name).join(", ")} for ${chosen.length} ${chosen.length === 1 ? "person" : "people"}.`)}
          >
            Turn off
          </button>
          <button className="link" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      <div className="admin-table-wrap">
        <table className="admin-table admin-plans">
          <thead>
            <tr>
              <th className="admin-check">
                <input
                  type="checkbox"
                  aria-label="Select everyone shown"
                  checked={allShown}
                  onChange={() => setSelected((s) => (allShown ? new Set([...s].filter((id) => !users.some((u) => u.id === id))) : new Set([...s, ...users.map((u) => u.id)])))}
                />
              </th>
              <th>Person</th>
              <th>Plan</th>
              {FEATURE_IDS.map((f) => (
                <th key={f} className={`admin-feat ${advSaved.includes(f) ? "" : "col-minor"}`} title={FEATURES[f].description}>
                  {FEATURES[f].name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={selected.has(u.id) ? "selected" : ""}>
                <td className="admin-check">
                  <input type="checkbox" aria-label={`Select ${u.name || u.email}`} checked={selected.has(u.id)} onChange={() => toggle(u.id)} />
                </td>
                <td onClick={() => toggle(u.id)} className="clickable-cell">
                  <strong>{u.name || u.email}</strong>
                  <div className="small muted">{u.email}</div>
                </td>
                <td>
                  <PlanCell u={u} />
                </td>
                {FEATURE_IDS.map((f) => (
                  <td key={f} className={`admin-feat ${advSaved.includes(f) ? "" : "col-minor"}`}>
                    <FeatureCell u={u} f={f} advanced={advSaved.includes(f)} gated={data.gated} busy={busy} onToggle={(on) => void run(() => api.adminGrant([u.id], [f], on), `${FEATURES[f].name} turned ${on ? "on" : "off"} for ${u.name || u.email}.`)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted admin-legend">
        <span className="feat on">On</span> turned on by you · <span className="feat viaplan">Plan</span> included in their {PLAN_NAME} subscription ·{" "}
        <span className="feat free">Free</span> not an advanced feature · <span className="feat off">Off</span> not available to them. Click On or Off to change it for one person.
      </p>
    </>
  );
}

function PlanCell({ u }: { u: AdminPlansUser }) {
  if (u.admin) return <span className="admin-badge">Admin</span>;
  if (u.planStatus && PLAN_INCLUDES.has(u.planStatus))
    return (
      <span className="admin-badge paid">
        {PLAN_NAME}
        {u.planStatus !== "active" ? ` (${u.planStatus.replace("_", " ")})` : ""}
      </span>
    );
  return <span className="muted">Free{u.planStatus === "canceled" ? " (cancelled)" : ""}</span>;
}

function FeatureCell(props: { u: AdminPlansUser; f: FeatureId; advanced: boolean; gated: boolean; busy: boolean; onToggle: (on: boolean) => void }) {
  const { u, f } = props;
  const granted = u.granted.includes(f);
  const viaPlan = !!u.planStatus && PLAN_INCLUDES.has(u.planStatus);
  if (u.admin) return <span className="feat viaplan" title="Admins have every feature">All</span>;
  if (!props.advanced && !granted) return <span className="feat free">Free</span>;
  if (viaPlan && !granted) return <span className="feat viaplan">Plan</span>;
  return (
    <button
      className={`feat ${granted ? "on" : "off"}`}
      disabled={props.busy}
      aria-pressed={granted}
      title={granted ? "Click to turn off" : "Click to turn on"}
      onClick={() => props.onToggle(!granted)}
    >
      {granted ? "On" : props.gated ? "Off" : "Off"}
    </button>
  );
}

function StripeCard({ s }: { s: Data["stripe"] }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="admin-card">
      <h2>Stripe</h2>
      {!s.configured ? (
        <>
          <p>
            <strong>Not set up.</strong> <span className="muted">People can't subscribe yet; you can still turn features on for them here.</span>
          </p>
          <ol className="small admin-steps">
            <li>
              In Stripe (stripe.com), switch on <strong>Test mode</strong> and copy the <strong>Secret key</strong> (starts with <code>sk_test_</code>) from Developers → API keys.
            </li>
            <li>
              On Render, add it as <code>STRIPE_SECRET_KEY</code> (Environment → Add). Render redeploys.
            </li>
            <li>
              That's enough to try it: the first Upgrade creates a <strong>$0 / month</strong> {PLAN_NAME} plan in Stripe, so no card is needed. For a real price later, set{" "}
              <code>STRIPE_PRICE_ID</code>.
            </li>
          </ol>
        </>
      ) : (
        <>
          <dl className="admin-facts admin-facts-tight">
            <div>
              <dt>Mode</dt>
              <dd>{s.mode === "live" ? <strong className="plan-live">Live: real charges</strong> : "Test (no real charges)"}</dd>
            </div>
            <div>
              <dt>Price</dt>
              <dd>{s.price ?? (s.priceId ? s.priceId : "$0 / month, created at the first upgrade")}</dd>
            </div>
            <div>
              <dt>Webhook</dt>
              <dd>{s.webhookSecret ? (s.lastWebhookAt ? `last heard from Stripe ${new Date(s.lastWebhookAt).toLocaleString()}` : "set up; nothing received yet") : "not set up (optional)"}</dd>
            </div>
          </dl>
          {!s.webhookSecret && (
            <div className="small admin-steps">
              Without a webhook, upgrades still work (they're confirmed when people come back from Stripe), but cancellations and failed payments won't be noticed. To set it up: in
              Stripe, Developers → Webhooks → Add endpoint, with this URL{" "}
              <code className="admin-url">{s.webhookUrl}</code>{" "}
              <button
                className="link"
                onClick={() => {
                  void navigator.clipboard?.writeText(s.webhookUrl).then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
              , events <code>checkout.session.completed</code> and <code>customer.subscription.*</code>. Then add its signing secret on Render as <code>STRIPE_WEBHOOK_SECRET</code>.
            </div>
          )}
          <p className="small muted">
            Manage billing opens Stripe's customer portal; in test mode, save its settings once in Stripe (Settings → Billing → Customer portal) before trying it.
          </p>
        </>
      )}
    </section>
  );
}
