export interface BillingPlanEntry {
  id: string;
  kind: "plan";
  name: string;
  description: string;
  priceUsd: string;
  interval: "month" | "year";
}

export interface BillingExtraUsageEntry {
  id: string;
  kind: "extra-usage";
  name: string;
  description: string;
  amountOptions: {
    minUsd: string;
    maxUsd: string;
    defaultUsd: string;
    presetsUsd: string[];
  };
}

export type BillingCatalogEntry = BillingPlanEntry | BillingExtraUsageEntry;

export interface BillingProductsResponse {
  entries: BillingCatalogEntry[];
  stripeConfigured: boolean;
}

export interface CreateCheckoutSessionRequest {
  entryId: string;
  amountUsd?: string;
  successUrl: string;
  cancelUrl: string;
}

export type CreateCheckoutSessionResponse =
  | { kind: "checkout"; sessionId: string; url: string }
  | { kind: "portal"; url: string };

export type BillingIncludedUsage =
  | { mode: "none" }
  | { mode: "subscription" | "free"; remainingPercent: number; overBudget: boolean };

export interface BillingBalanceResponse {
  /** Extra-usage balance in USD; user paid real dollars. e.g. "7.35" */
  purchasedBalanceUsd: string;
  canStartTurn: boolean;
  includedUsage: BillingIncludedUsage;
}

export interface BillingTransaction {
  id: string;
  kind: "purchase" | "grant" | "consumption" | "adjustment";
  label: string;
  amountUsd: string;
  createdAt: string;
}

export interface BillingTransactionsResponse {
  transactions: BillingTransaction[];
  usage: { totalConsumedUsd: string; transactionCount: number };
}

export interface BillingWebhookResponse {
  received: true;
}
