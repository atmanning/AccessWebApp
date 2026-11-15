/**
 * Stripe billing for the Advanced plan, under /api/billing.
 *
 *   POST /checkout   starts Stripe Checkout for the plan and returns its address
 *   POST /confirm    back from Checkout: reads the session from Stripe and turns the plan on
 *                    (so it works even before a webhook is set up)
 *   POST /portal     Stripe's customer portal: change card, see invoices, cancel
 *   POST /webhook    Stripe tells us about subscriptions changing, renewing or ending
 *   GET  /status     this person's plan and features
 *
 * Setup: STRIPE_SECRET_KEY (test keys start sk_test_), optionally STRIPE_PRICE_ID, and for the
 * webhook STRIPE_WEBHOOK_SECRET. Without a price id, a $0 monthly "Advanced" price is created in
 * Stripe the first time someone upgrades, so the whole flow can be tried without charging anyone.
 */
import express, { Router, type Request } from "express";
import type Stripe from "stripe";
import { z } from "zod";
import { PLAN_NAME, type BillingStatus, type PlanStatus } from "../../shared/plans.js";
import type { ActivityLog } from "./activity.js";
import type { DB } from "./db.js";
import type { Plans } from "./plans.js";
import { httpError } from "./projects.js";

export interface BillingOptions {
  stripe: Stripe | null;
  webhookSecret: string | null;
  priceId: string | null;
  /** From the key: sk_test_… or sk_live_…. */
  mode?: "test" | "live" | null;
}

interface PlanRow {
  id: string;
  email: string;
  name: string;
  features: string | null;
  plan_status: string | null;
  plan_renews_at: string | null;
  plan_cancel_at_period_end: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

const returnSchema = z.object({ returnTo: z.string().max(2000).optional() });

/** Where to send someone back to: a path on this site only. */
function backTo(req: Request, returnTo: string | undefined) {
  const host = req.get("host") ?? "localhost";
  let origin = `${req.protocol}://${host}`;
  const o = req.get("origin");
  try {
    if (o && new URL(o).host === host) origin = o;
  } catch {
    /* use the request's own address */
  }
  const path = returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
  return { origin, path };
}

const withParams = (origin: string, path: string, params: Record<string, string>) => {
  const u = new URL(path, origin);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  // Stripe fills in {CHECKOUT_SESSION_ID}; keep the braces unescaped.
  return u.toString().replace(/%7BCHECKOUT_SESSION_ID%7D/g, "{CHECKOUT_SESSION_ID}");
};

/** A subscription's renewal date (it moved onto subscription items in newer Stripe API versions). */
function periodEnd(sub: Stripe.Subscription): string | null {
  const s = sub as unknown as { current_period_end?: number; items?: { data?: { current_period_end?: number }[] } };
  const t = s.current_period_end ?? s.items?.data?.[0]?.current_period_end;
  return t ? new Date(t * 1000).toISOString() : null;
}

export function priceLabel(p: Pick<Stripe.Price, "unit_amount" | "currency" | "recurring">) {
  const amount = ((p.unit_amount ?? 0) / 100).toLocaleString("en-US", { style: "currency", currency: p.currency.toUpperCase() });
  return p.recurring ? `${amount} / ${p.recurring.interval_count > 1 ? `${p.recurring.interval_count} ${p.recurring.interval}s` : p.recurring.interval}` : amount;
}

export function createBilling(db: DB, plans: Plans, opts: BillingOptions & { log: ActivityLog; isAdmin: (u: { id: string; email: string }) => boolean }) {
  const { stripe } = opts;
  const byId = db.prepare("SELECT id, email, name, features, plan_status, plan_renews_at, plan_cancel_at_period_end, stripe_customer_id, stripe_subscription_id FROM users WHERE id = ?");
  const byCustomer = db.prepare("SELECT id, email, plan_status FROM users WHERE stripe_customer_id = ?");
  const saveSub = db.prepare(
    `UPDATE users SET stripe_customer_id = COALESCE(@customer, stripe_customer_id), stripe_subscription_id = @subscription,
       plan_status = @status, plan_renews_at = @renews, plan_cancel_at_period_end = @cancel WHERE id = @id`,
  );

  /** The plan's Stripe price: STRIPE_PRICE_ID, or a $0 monthly one made (once) for trying it out. */
  async function priceId(): Promise<string> {
    if (opts.priceId) return opts.priceId;
    const saved = plans.settings.get("stripe.price");
    if (saved) return saved;
    const product = await stripe!.products.create({ name: `Access Web ${PLAN_NAME}`, description: "Sharing, public links, MySQL connections and Access files." });
    const price = await stripe!.prices.create({ product: product.id, unit_amount: 0, currency: "usd", recurring: { interval: "month" }, nickname: `${PLAN_NAME} (free while testing)` });
    plans.settings.set("stripe.price", price.id);
    plans.settings.set("stripe.price_label", priceLabel(price));
    return price.id;
  }

  /** "$0.00 / month", looked up once and remembered. */
  async function price(): Promise<string | null> {
    if (!stripe) return null;
    const id = opts.priceId ?? plans.settings.get("stripe.price");
    if (!id) return "$0.00 / month";
    const cached = plans.settings.get("stripe.price_label");
    if (cached && plans.settings.get("stripe.price_label_for") === id) return cached;
    try {
      const p = await stripe.prices.retrieve(id);
      plans.settings.set("stripe.price_label", priceLabel(p));
      plans.settings.set("stripe.price_label_for", id);
      return priceLabel(p);
    } catch {
      return null;
    }
  }

  /** Records a subscription's state on its person, and logs plan changes. */
  function applySubscription(userId: string, sub: Stripe.Subscription, ip: string | null) {
    const before = byId.get(userId) as PlanRow | undefined;
    if (!before) return;
    const status = sub.status as PlanStatus;
    saveSub.run({
      id: userId,
      customer: typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null,
      subscription: sub.id,
      status,
      renews: periodEnd(sub),
      cancel: sub.cancel_at_period_end ? 1 : 0,
    });
    if (before.plan_status !== status) {
      opts.log.write({ action: "plan_change", userId, email: before.email, detail: `${before.plan_status ?? "free"} → ${status}`, ip });
    }
  }

  function status(user: { id: string; email: string }): Promise<BillingStatus> {
    const row = byId.get(user.id) as PlanRow;
    return price().then((p) => ({
      gated: plans.gated(),
      advanced: plans.advanced(),
      features: plans.featuresOf(row),
      granted: plans.featureList(row.features),
      admin: opts.isAdmin(user),
      plan: row.plan_status ? { status: row.plan_status as PlanStatus, renewsAt: row.plan_renews_at, cancelAtPeriodEnd: !!row.plan_cancel_at_period_end } : null,
      billing: !!stripe,
      price: p,
    }));
  }

  const router = Router();
  router.use((req, res, next) => (req.user ? next() : void res.status(401).json({ error: "Please sign in." })));

  router.get("/status", async (req, res) => {
    res.json(await status(req.user!));
  });

  const needStripe = () => {
    if (!stripe) throw httpError(400, "Upgrading online isn't set up on this site yet. Ask the site's administrator to turn on the features you need.");
    return stripe;
  };

  router.post("/checkout", async (req, res) => {
    const s = needStripe();
    const { returnTo } = returnSchema.parse(req.body);
    const row = byId.get(req.user!.id) as PlanRow;
    if (row.stripe_subscription_id && ["active", "trialing", "past_due"].includes(row.plan_status ?? "")) {
      throw httpError(409, "You're already on the Advanced plan. Use Manage billing to change it.");
    }
    const { origin, path } = backTo(req, returnTo);
    const session = await s.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: await priceId(), quantity: 1 }],
      // A $0 plan (or a free trial) needs no card.
      payment_method_collection: "if_required",
      client_reference_id: row.id,
      ...(row.stripe_customer_id ? { customer: row.stripe_customer_id } : { customer_email: row.email }),
      subscription_data: { metadata: { userId: row.id } },
      metadata: { userId: row.id },
      allow_promotion_codes: true,
      success_url: withParams(origin, path, { billing: "done", session_id: "{CHECKOUT_SESSION_ID}" }),
      cancel_url: withParams(origin, path, { billing: "cancelled" }),
    });
    if (!session.url) throw httpError(502, "Stripe didn't start the checkout. Please try again.");
    res.json({ url: session.url });
  });

  router.post("/confirm", async (req, res) => {
    const s = needStripe();
    const { sessionId } = z.object({ sessionId: z.string().min(5).max(255) }).parse(req.body);
    const session = await s.checkout.sessions.retrieve(sessionId, { expand: ["subscription"] });
    if (session.client_reference_id !== req.user!.id) throw httpError(404, "That checkout isn't yours.");
    if (session.status !== "complete" || !session.subscription || typeof session.subscription === "string") {
      throw httpError(409, "That checkout wasn't finished, so your plan hasn't changed.");
    }
    applySubscription(req.user!.id, session.subscription, req.ip ?? null);
    res.json(await status(req.user!));
  });

  router.post("/portal", async (req, res) => {
    const s = needStripe();
    const { returnTo } = returnSchema.parse(req.body);
    const row = byId.get(req.user!.id) as PlanRow;
    if (!row.stripe_customer_id) throw httpError(400, "You don't have a subscription yet.");
    const { origin, path } = backTo(req, returnTo);
    try {
      const portal = await s.billingPortal.sessions.create({ customer: row.stripe_customer_id, return_url: withParams(origin, path, { billing: "portal" }) });
      res.json({ url: portal.url });
    } catch (e) {
      // The usual cause in test mode: the portal hasn't been saved once in Stripe's dashboard.
      throw httpError(400, `Stripe couldn't open billing management: ${(e as Error).message}`);
    }
  });

  /** Stripe's webhook, mounted before express.json (the signature is over the raw body). */
  const webhook = Router();
  webhook.post("/", express.raw({ type: () => true, limit: "1mb" }), async (req, res) => {
    if (!stripe || !opts.webhookSecret) return void res.status(400).json({ error: "Webhooks aren't set up (STRIPE_WEBHOOK_SECRET)." });
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body as Buffer, req.get("stripe-signature") ?? "", opts.webhookSecret);
    } catch {
      return void res.status(400).json({ error: "That webhook's signature didn't match." });
    }
    plans.settings.set("stripe.last_webhook", new Date().toISOString());
    const findUser = (customer: string | null, metaUser?: string | null) =>
      (customer ? (byCustomer.get(customer) as { id: string } | undefined)?.id : undefined) ?? (metaUser && byId.get(metaUser) ? metaUser : undefined);
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = findUser(null, session.client_reference_id ?? session.metadata?.userId);
      if (userId && typeof session.subscription === "string") {
        applySubscription(userId, await stripe.subscriptions.retrieve(session.subscription), null);
      }
    } else if (event.type.startsWith("customer.subscription.")) {
      const sub = event.data.object as Stripe.Subscription;
      const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      const userId = findUser(customer, sub.metadata?.userId);
      if (userId) applySubscription(userId, event.type === "customer.subscription.deleted" ? { ...sub, status: "canceled" } : sub, null);
    }
    res.json({ received: true });
  });

  return { router, webhook, status, price };
}
