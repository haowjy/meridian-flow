/** Credit ledger port consumed by runtime cost gates, billing APIs, and grant provisioning. */

export type CreditGrantSource = "manual" | "stripe" | "subscription" | "free";

export interface CreditGrantInput {
  userId: string;
  source: CreditGrantSource;
  amountMillicredits: string;
  /** Machine idempotency/grouping key for non-Stripe grants (free_tier_*). Never display to users. */
  reason?: string | null;
  /** Human-facing activity-feed label. This is the only grant reason text safe to display. */
  displayReason?: string | null;
  expiresAt?: string | Date | null;
  stripeSessionId?: string | null;
  /** Machine idempotency key for Stripe grants and deterministic free-tier grants. Never display to users. */
  stripeIdempotencyId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreditGrantResult {
  transactionId: string;
  created: boolean;
}

export interface CreditDebitInput {
  userId: string;
  rootThreadId: string;
  threadId: string;
  turnId: string;
  agentSlug: string;
  millicredits: string;
  usageEventId: string;
}

/** Internal lot view for the balance route to compute percentage + extra-usage USD. */
export interface CreditLotView {
  source: "purchase" | "grant" | "subscription" | "debt";
  balanceMillicredits: string;
  originalMillicredits: string;
  expiresAt: string | null;
  grantReason: string | null;
}

export interface CreditTransactionRow {
  id: string;
  transactionType: string;
  amountMillicredits: string;
  sourceType: string | null;
  displayReason: string | null;
  usageEventId: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface CreditLedger {
  grant(input: CreditGrantInput): Promise<CreditGrantResult>;
  debit(input: CreditDebitInput): Promise<{ transactionId: string }>;
  getBalance(input: { userId: string }): Promise<string>;
  getBalanceBreakdown(input: { userId: string }): Promise<{ lots: CreditLotView[] }>;
  listTransactions(input: { userId: string; limit?: number }): Promise<CreditTransactionRow[]>;
  getThreadDebitTotal(input: { userId: string; threadId: string }): Promise<string>;
  /** Entitlement marker: expires_at > NOW() regardless of balance. */
  hasUnexpiredLot(input: { userId: string; source: CreditGrantSource }): Promise<boolean>;
}

export function assertPositiveMillicredits(value: string): bigint {
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new Error(`Millicredits must be positive; got ${value}`);
  return parsed;
}
