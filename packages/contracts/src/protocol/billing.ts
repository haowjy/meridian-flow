export type BillingCatalogEntryKind = "pack" | "plan" | "payg" | "needs-credentials";

export interface BillingCatalogEntry {
  id: string;
  kind: BillingCatalogEntryKind;
  name: string;
  description: string;
  credits: number;
  millicredits: string;
  priceUsd: string;
  interval?: "month" | "year";
  stripePriceEnv?: string;
  needsCredentials?: boolean;
}

export interface BillingCatalog {
  entries: BillingCatalogEntry[];
}

export interface BillingBalanceResponse {
  totalBalanceMillicredits: string;
  grantBalanceMillicredits: string;
  subscriptionBalanceMillicredits: string;
  purchasedBalanceMillicredits: string;
  debtBalanceMillicredits: string;
  includedBudgetMillicredits: string;
  includedUsedMillicredits: string;
  includedUsagePercent: number | null;
  canStartTurn: boolean;
}

export interface BillingTransaction {
  id: string;
  transactionType: string;
  amountMillicredits: string;
  sourceType: string | null;
  reason: string | null;
  usageEventId: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface BillingTransactionsResponse {
  transactions: BillingTransaction[];
  usage: {
    totalConsumedMillicredits: string;
    transactionCount: number;
  };
}

export interface BillingPacksPlansResponse extends BillingCatalog {
  provider: {
    mode: "stripe" | "fake";
    needsCredentials: boolean;
    message: string | null;
  };
}

export interface CreateCheckoutSessionRequest {
  entryId: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CreateCheckoutSessionResponse {
  sessionId: string;
  url: string;
  mode: "stripe" | "fake";
  needsCredentials: boolean;
}

export interface BillingWebhookResponse {
  received: true;
  action: "granted" | "ignored" | "subscription_updated";
}
