// @ts-nocheck
/**
 * Purpose: In-memory implementation of the credit ledger port for tests and
 * local smoke composition.
 * Key decisions: stores transactions and dedupes model-call debits by
 * workbench+usageEventId, matching the production idempotency contract without
 * reproducing Postgres FIFO lot locking in memory.
 */
import {
  assertPositiveMillicredits,
  type CreditDebitInput,
  type CreditGrantInput,
  type CreditLedger,
} from "../../domain/credit-ledger.js";

type Transaction = {
  id: string;
  userId: string;
  workbenchId: string;
  amountMillicredits: bigint;
  metadata: Record<string, unknown>;
};

function matches(tx: Transaction, input: { userId: string; workbenchId: string }): boolean {
  return tx.userId === input.userId && tx.workbenchId === input.workbenchId;
}

export function createInMemoryCreditLedger(initialTransactions: Transaction[] = []): CreditLedger {
  const transactions = [...initialTransactions];
  const debitIdsByWorkbenchUsageEvent = new Map<string, string>();

  return {
    async grant(input: CreditGrantInput) {
      const amount = assertPositiveMillicredits(input.amountMillicredits);
      const id = crypto.randomUUID();
      transactions.push({
        id,
        userId: input.userId,
        workbenchId: input.workbenchId,
        amountMillicredits: amount,
        metadata: { source: input.source, reason: input.reason ?? null, ...(input.metadata ?? {}) },
      });
      return { transactionId: id };
    },

    async debit(input: CreditDebitInput) {
      const amount = assertPositiveMillicredits(input.millicredits);
      const idempotencyKey = `${input.workbenchId}:${input.usageEventId}`;
      const existingId = debitIdsByWorkbenchUsageEvent.get(idempotencyKey);
      if (existingId) return { transactionId: existingId };

      const id = crypto.randomUUID();
      transactions.push({
        id,
        userId: input.userId,
        workbenchId: input.workbenchId,
        amountMillicredits: -amount,
        metadata: {
          rootThreadId: input.rootThreadId,
          threadId: input.threadId,
          turnId: input.turnId,
          agentSlug: input.agentSlug,
          usageEventId: input.usageEventId ?? null,
        },
      });
      debitIdsByWorkbenchUsageEvent.set(idempotencyKey, id);
      return { transactionId: id };
    },

    async getBalance(input) {
      return transactions
        .filter((tx) => matches(tx, input))
        .reduce((sum, tx) => sum + tx.amountMillicredits, 0n)
        .toString();
    },

    async getRunDebitTotal(input) {
      return transactions
        .filter(
          (tx) =>
            matches(tx, input) &&
            tx.metadata.rootThreadId === input.rootThreadId &&
            tx.amountMillicredits < 0n,
        )
        .reduce((sum, tx) => sum - tx.amountMillicredits, 0n)
        .toString();
    },

    async getAgentDebitTotals(input) {
      const totals = new Map<string, bigint>();
      for (const tx of transactions) {
        if (
          !matches(tx, input) ||
          tx.metadata.rootThreadId !== input.rootThreadId ||
          tx.amountMillicredits >= 0n
        )
          continue;
        const agentSlug =
          typeof tx.metadata.agentSlug === "string" ? tx.metadata.agentSlug : "unknown";
        totals.set(agentSlug, (totals.get(agentSlug) ?? 0n) - tx.amountMillicredits);
      }
      return [...totals.entries()].map(([agentSlug, millicredits]) => ({
        agentSlug,
        millicredits: millicredits.toString(),
      }));
    },

    async getThreadDebitTotal(input) {
      return transactions
        .filter(
          (tx) =>
            matches(tx, input) &&
            tx.metadata.threadId === input.threadId &&
            tx.amountMillicredits < 0n,
        )
        .reduce((sum, tx) => sum - tx.amountMillicredits, 0n)
        .toString();
    },
  };
}
