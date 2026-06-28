export type BillingCatalogEntryKind = "plan" | "extra-usage";

export interface BillingCatalogEntry {
  id: string;
  kind: BillingCatalogEntryKind;
  name: string;
  description: string;
  priceUsd: string;
  interval?: "month" | "year";
}

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

export interface BillingBalanceResponse {
  /** Extra-usage balance in USD; user paid real dollars. e.g. "7.35" */
  purchasedBalanceUsd: string;
  /** Subscription/free usage as percent (0..100+). Null when usageMode==="none". */
  includedUsagePercent: number | null;
  usageMode: "subscription" | "free" | "none";
  canStartTurn: boolean;
}

export interface BillingTransaction {
  id: string;
  transactionType: string;
  amountUsd: string;
  sourceType: string | null;
  reason: string | null;
  usageEventId: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface BillingTransactionsResponse {
  transactions: BillingTransaction[];
  usage: { totalConsumedUsd: string; transactionCount: number };
}

export interface BillingWebhookResponse {
  received: true;
}
