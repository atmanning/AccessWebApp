/**
 * Plans: some features can be reserved for people on the Advanced plan (a Stripe subscription) or
 * people the admin has enabled them for. Nothing is reserved until the admin turns on "Require a
 * plan" on the admin page's Plans tab.
 */

export const FEATURES = {
  sharing: { name: "Sharing", description: "Share databases with other people, or with anyone who has the link." },
  public: { name: "Public links", description: "Public databases, public reports, and name-tag QR codes anyone can open without an account." },
  mysql: { name: "MySQL connections", description: "Connect to MySQL or MariaDB databases: link, query and import their tables." },
  accdb: { name: "Access files", description: "Import Access .accdb and .mdb files, and download databases as .accdb." },
  ai: { name: "AI assistant", description: "Describe a query or a database in plain words and have it built." },
} as const;

export type FeatureId = keyof typeof FEATURES;
export const FEATURE_IDS = Object.keys(FEATURES) as FeatureId[];

/** A Stripe subscription's status; active, trialing and past_due (still in grace) include the plan. */
export type PlanStatus = "active" | "trialing" | "past_due" | "unpaid" | "canceled" | "incomplete" | "incomplete_expired" | "paused";
export const PLAN_INCLUDES = new Set<string>(["active", "trialing", "past_due"]);

export const PLAN_NAME = "Advanced";

export interface BillingStatus {
  /** "Require a plan" is on: advanced features need the plan or the admin. */
  gated: boolean;
  /** The features reserved for the plan. */
  advanced: FeatureId[];
  /** What this person can use right now. */
  features: FeatureId[];
  /** Features the admin enabled for this person (whatever their plan). */
  granted: FeatureId[];
  admin: boolean;
  plan: { status: PlanStatus; renewsAt: string | null; cancelAtPeriodEnd: boolean } | null;
  /** Stripe is set up, so people can subscribe here. */
  billing: boolean;
  /** The plan's price, e.g. "$0.00 / month"; null until known. */
  price: string | null;
}

export interface AdminPlansUser {
  id: string;
  email: string;
  name: string;
  planStatus: PlanStatus | null;
  granted: FeatureId[];
  features: FeatureId[];
  admin: boolean;
}

export interface AdminPlans {
  gated: boolean;
  advanced: FeatureId[];
  users: AdminPlansUser[];
  stripe: {
    configured: boolean;
    mode: "test" | "live" | null;
    priceId: string | null;
    price: string | null;
    webhookSecret: boolean;
    lastWebhookAt: string | null;
    webhookUrl: string;
  };
}

/** The message when a feature is refused (the server's 402 "upgrade" answer). */
export interface UpgradeNeeded {
  code: "upgrade";
  feature: FeatureId;
  /** The person asking owns the database (so upgrading would help them). */
  yours: boolean;
}
