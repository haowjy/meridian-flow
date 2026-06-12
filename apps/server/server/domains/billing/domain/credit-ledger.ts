// @ts-nocheck
/**
 * Purpose: Defines the workbench credit ledger port consumed by the runtime
 * cost gate and spawn rollups.
 * Key decisions: production uses credit lots as canonical balance truth;
 * debits require a usageEventId so replayed model-response persistence is
 * idempotent instead of double-charging.
 */

export type CreditGrantSource = "manual" | "stripe" | "subscription";

export interface CreditGrantInput {
  userId: string;
  workbenchId: string;
  source: CreditGrantSource;
  amountMillicredits: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreditDebitInput {
  userId: string;
  workbenchId: string;
  rootThreadId: string;
  threadId: string;
  turnId: string;
  agentSlug: string;
  millicredits: string;
  usageEventId: string;
}

export interface CreditLedger {
  grant(input: CreditGrantInput): Promise<{ transactionId: string }>;
  debit(input: CreditDebitInput): Promise<{ transactionId: string }>;
  getBalance(input: { userId: string; workbenchId: string }): Promise<string>;
  getRunDebitTotal(input: {
    userId: string;
    workbenchId: string;
    rootThreadId: string;
  }): Promise<string>;
  getAgentDebitTotals(input: {
    userId: string;
    workbenchId: string;
    rootThreadId: string;
  }): Promise<Array<{ agentSlug: string; millicredits: string }>>;
  getThreadDebitTotal(input: {
    userId: string;
    workbenchId: string;
    threadId: string;
  }): Promise<string>;
}

export function assertPositiveMillicredits(value: string): bigint {
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new Error(`Millicredits must be positive; got ${value}`);
  return parsed;
}
