import type { CreditLedger } from "./credit-ledger.js";
export const FREE_MONTHLY_CREDITS = 200;
export const FREE_MONTHLY_MILLICREDITS = String(FREE_MONTHLY_CREDITS * 1000);
export interface FreeGrantClock {
  now(): Date;
}
export interface FreeGrantPipeline {
  ensureFreeCredits(input: { userId: string; projectId: string }): Promise<void>;
}
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
export function monthlyGrantReason(now: Date): string {
  return `monthly_${now.getUTCFullYear()}_${pad2(now.getUTCMonth() + 1)}`;
}
export function nextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}
function sameUtcMonth(aIso: string, b: Date): boolean {
  const a = new Date(aIso);
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}
export function createFreeGrantPipeline(input: {
  ledger: CreditLedger;
  clock?: FreeGrantClock;
}): FreeGrantPipeline {
  const clock = input.clock ?? { now: () => new Date() };
  return {
    async ensureFreeCredits({ userId, projectId }) {
      const now = clock.now();
      const monthlyReason = monthlyGrantReason(now);
      const status = await input.ledger.getFreeGrantStatus({ userId, monthlyReason });
      if (!status.signupGrantedAt) {
        await input.ledger.grant({
          userId,
          projectId,
          source: "manual",
          amountMillicredits: FREE_MONTHLY_MILLICREDITS,
          reason: "signup",
          expiresAt: nextMonthStart(now),
          metadata: { grantKind: "signup", credits: FREE_MONTHLY_CREDITS },
        });
        return;
      }
      if (sameUtcMonth(status.signupGrantedAt, now) || status.monthlyGranted) return;
      await input.ledger.grant({
        userId,
        projectId,
        source: "manual",
        amountMillicredits: FREE_MONTHLY_MILLICREDITS,
        reason: monthlyReason,
        expiresAt: nextMonthStart(now),
        metadata: { grantKind: "monthly", month: monthlyReason, credits: FREE_MONTHLY_CREDITS },
      });
    },
  };
}
export function createGrantingCreditLedger(input: {
  ledger: CreditLedger;
  grants: FreeGrantPipeline;
}): CreditLedger {
  async function ensure(userId: string, projectId: string) {
    await input.grants.ensureFreeCredits({ userId, projectId });
  }
  return {
    grant: (grantInput) => input.ledger.grant(grantInput),
    async debit(debitInput) {
      await ensure(debitInput.userId, debitInput.projectId);
      return input.ledger.debit(debitInput);
    },
    async getBalance(balanceInput) {
      await ensure(balanceInput.userId, balanceInput.projectId);
      return input.ledger.getBalance(balanceInput);
    },
    async getBalanceBreakdown(balanceInput) {
      await ensure(balanceInput.userId, balanceInput.projectId);
      return input.ledger.getBalanceBreakdown(balanceInput);
    },
    async listTransactions(listInput) {
      await ensure(listInput.userId, listInput.projectId);
      return input.ledger.listTransactions(listInput);
    },
    getFreeGrantStatus: (statusInput) => input.ledger.getFreeGrantStatus(statusInput),
    async getRunDebitTotal(totalInput) {
      await ensure(totalInput.userId, totalInput.projectId);
      return input.ledger.getRunDebitTotal(totalInput);
    },
    async getAgentDebitTotals(totalInput) {
      await ensure(totalInput.userId, totalInput.projectId);
      return input.ledger.getAgentDebitTotals(totalInput);
    },
    async getThreadDebitTotal(totalInput) {
      await ensure(totalInput.userId, totalInput.projectId);
      return input.ledger.getThreadDebitTotal(totalInput);
    },
  };
}
