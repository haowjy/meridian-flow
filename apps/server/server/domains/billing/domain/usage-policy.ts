/** Billing usage policy: free-tier entitlement plus turn-start/continuation gates. */
import type { CreditDebitInput, CreditLedger } from "./credit-ledger.js";
import { ensureFreeTier } from "./free-grants.js";

export interface BillingUsagePolicy {
  canStartTurn(userId: string): Promise<boolean>;
  canContinueModelCall(userId: string): Promise<boolean>;
  debit(input: CreditDebitInput): Promise<{ transactionId: string }>;
}

async function balanceAfterEntitlement(ledger: CreditLedger, userId: string): Promise<bigint> {
  await ensureFreeTier(ledger, userId);
  return BigInt(await ledger.getBalance({ userId }));
}

export function createBillingUsagePolicy(ledger: CreditLedger): BillingUsagePolicy {
  return {
    async canStartTurn(userId) {
      return (await balanceAfterEntitlement(ledger, userId)) > 0n;
    },
    async canContinueModelCall(userId) {
      return (await balanceAfterEntitlement(ledger, userId)) >= 0n;
    },
    async debit(input) {
      await ensureFreeTier(ledger, input.userId);
      return ledger.debit(input);
    },
  };
}
