/** Server-owned billing catalog: Stripe price bindings plus internal grant amounts. */
import type { BillingCatalogEntry } from "@meridian/contracts/protocol";

export interface BillingPlanCatalogEntry extends BillingCatalogEntry {
  kind: "plan";
  grantMillicredits: string;
  interval: "month" | "year";
  stripePriceEnv: string;
}

export interface ExtraUsageConfig extends BillingCatalogEntry {
  kind: "extra-usage";
  minUsd: string;
  incrementUsd: string;
  /** Extra usage is 1:1: $1 paid grants 100,000 millicredits. */
  millicreditsPerUsd: string;
}

export type BillingCatalogServerEntry = BillingPlanCatalogEntry | ExtraUsageConfig;

export const FREE_TIER = {
  id: "plan_free",
  kind: "plan" as const,
  name: "Free",
  description: "Monthly starter usage for trying Meridian Flow.",
  priceUsd: "0.00",
  grantMillicredits: "200000",
  interval: "month" as const,
  stripePriceEnv: "STRIPE_PRICE_PLAN_FREE",
};

export const BILLING_PLANS = [
  {
    id: "plan_standard",
    kind: "plan" as const,
    name: "Standard",
    description: "Monthly usage for steady serial drafting.",
    priceUsd: "10.00",
    grantMillicredits: "1000000",
    interval: "month" as const,
    stripePriceEnv: "STRIPE_PRICE_PLAN_STANDARD",
  },
  {
    id: "plan_premium",
    kind: "plan" as const,
    name: "Premium",
    description: "Higher monthly usage for long drafting days.",
    priceUsd: "25.00",
    grantMillicredits: "2800000",
    interval: "month" as const,
    stripePriceEnv: "STRIPE_PRICE_PLAN_PREMIUM",
  },
] satisfies BillingPlanCatalogEntry[];

export const EXTRA_USAGE = {
  id: "extra_usage",
  kind: "extra-usage" as const,
  name: "Extra usage",
  description: "Add standalone pay-as-you-go balance in $5 increments.",
  priceUsd: "5.00",
  minUsd: "5.00",
  incrementUsd: "5.00",
  millicreditsPerUsd: "100000",
} satisfies ExtraUsageConfig;

export const BILLING_CATALOG = {
  entries: [...BILLING_PLANS, EXTRA_USAGE],
};

export function catalogEntry(id: string): BillingCatalogServerEntry | null {
  return BILLING_CATALOG.entries.find((entry) => entry.id === id) ?? null;
}

export function publicCatalogEntry(entry: BillingCatalogServerEntry): BillingCatalogEntry {
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    description: entry.description,
    priceUsd: entry.priceUsd,
    ...(entry.kind === "plan" ? { interval: entry.interval } : {}),
  };
}
