import type { BillingCatalog, BillingCatalogEntry } from "@meridian/contracts/protocol";

export const BILLING_CATALOG: BillingCatalog = {
  entries: [
    {
      id: "pack_starter",
      kind: "pack",
      name: "Starter bundle",
      description: "1,000 credits for focused drafting sessions.",
      credits: 1000,
      millicredits: "1000000",
      priceUsd: "10.00",
      stripePriceEnv: "STRIPE_PRICE_PACK_STARTER",
    },
    {
      id: "pack_marathon",
      kind: "pack",
      name: "Marathon bundle",
      description: "5,500 credits for long drafting days.",
      credits: 5500,
      millicredits: "5500000",
      priceUsd: "50.00",
      stripePriceEnv: "STRIPE_PRICE_PACK_MARATHON",
    },
    {
      id: "plan_pro",
      kind: "plan",
      name: "Pro monthly",
      description: "Monthly subscription credits plus higher Muse fan-out limits.",
      credits: 5000,
      millicredits: "5000000",
      priceUsd: "49.00",
      interval: "month",
      stripePriceEnv: "STRIPE_PRICE_PLAN_PRO",
    },
    {
      id: "payg",
      kind: "payg",
      name: "Pay as you go",
      description: "Credits-only billing: buy bundles whenever the balance runs low.",
      credits: 0,
      millicredits: "0",
      priceUsd: "0.00",
    },
  ],
};

export function catalogEntry(id: string): BillingCatalogEntry | null {
  return BILLING_CATALOG.entries.find((entry) => entry.id === id) ?? null;
}

export function stripePriceIdFor(
  entry: BillingCatalogEntry,
  env: NodeJS.ProcessEnv,
): string | null {
  if (!entry.stripePriceEnv) return null;
  return env[entry.stripePriceEnv] || null;
}
