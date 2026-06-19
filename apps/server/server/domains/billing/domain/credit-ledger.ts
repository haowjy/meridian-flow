/** Credit ledger port consumed by runtime cost gates, billing APIs, and grant provisioning. */
import type { BillingBalanceResponse, BillingTransaction } from "@meridian/contracts/protocol";

export type CreditGrantSource = "manual" | "stripe" | "subscription";
export interface CreditGrantInput {
  userId: string;
  projectId: string;
  source: CreditGrantSource;
  amountMillicredits: string;
  reason?: string | null;
  expiresAt?: string | Date | null;
  stripeSessionId?: string | null;
  metadata?: Record<string, unknown>;
}
export interface CreditGrantResult {
  transactionId: string;
  created: boolean;
}
export interface CreditDebitInput {
  userId: string;
  projectId: string;
  rootThreadId: string;
  threadId: string;
  turnId: string;
  agentSlug: string;
  millicredits: string;
  usageEventId: string;
}
// Wire-canonical: the credit ledger port speaks the billing protocol types
// directly, so the domain return shape and the HTTP response can't drift apart
// (they were previously field-for-field duplicates kept in sync by hand).
export type CreditTransactionSummary = BillingTransaction;
export type CreditBalanceBreakdown = BillingBalanceResponse;
export interface FreeGrantStatus {
  signupGrantedAt: string | null;
  monthlyGranted: boolean;
}
export interface CreditLedger {
  grant(input: CreditGrantInput): Promise<CreditGrantResult>;
  debit(input: CreditDebitInput): Promise<{ transactionId: string }>;
  getBalance(input: { userId: string; projectId: string }): Promise<string>;
  getBalanceBreakdown(input: {
    userId: string;
    projectId: string;
  }): Promise<CreditBalanceBreakdown>;
  listTransactions(input: {
    userId: string;
    projectId: string;
    limit?: number;
  }): Promise<CreditTransactionSummary[]>;
  getFreeGrantStatus(input: { userId: string; monthlyReason: string }): Promise<FreeGrantStatus>;
  getRunDebitTotal(input: {
    userId: string;
    projectId: string;
    rootThreadId: string;
  }): Promise<string>;
  getAgentDebitTotals(input: {
    userId: string;
    projectId: string;
    rootThreadId: string;
  }): Promise<Array<{ agentSlug: string; millicredits: string }>>;
  getThreadDebitTotal(input: {
    userId: string;
    projectId: string;
    threadId: string;
  }): Promise<string>;
}
export function assertPositiveMillicredits(value: string): bigint {
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new Error(`Millicredits must be positive; got ${value}`);
  return parsed;
}
export function usagePercent(usedMillicredits: bigint, budgetMillicredits: bigint): number | null {
  if (budgetMillicredits <= 0n) return null;
  return Number((usedMillicredits * 1000n) / budgetMillicredits) / 10;
}
