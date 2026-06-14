import {
  assertPositiveMillicredits,
  type CreditDebitInput,
  type CreditGrantInput,
  type CreditLedger,
  usagePercent,
} from "../../domain/credit-ledger.js";

type Tx = {
  id: string;
  userId: string;
  projectId: string;
  transactionType: string;
  amountMillicredits: bigint;
  sourceType: string | null;
  reason: string | null;
  usageEventId: string | null;
  createdAt: Date;
  metadata: Record<string, unknown>;
};
function matches(tx: Tx, input: { userId: string; projectId: string }) {
  return tx.userId === input.userId && tx.projectId === input.projectId;
}
function sourceType(input: CreditGrantInput) {
  return input.source === "manual"
    ? "grant"
    : input.source === "stripe"
      ? "purchase"
      : "subscription";
}
function summary(tx: Tx) {
  return {
    id: tx.id,
    transactionType: tx.transactionType,
    amountMillicredits: tx.amountMillicredits.toString(),
    sourceType: tx.sourceType,
    reason: tx.reason,
    usageEventId: tx.usageEventId,
    createdAt: tx.createdAt.toISOString(),
    metadata: tx.metadata,
  };
}
export function createInMemoryCreditLedger(initialTransactions: Tx[] = []): CreditLedger {
  const transactions = [...initialTransactions];
  const debitIds = new Map<string, string>();
  return {
    async grant(input: CreditGrantInput) {
      const amount = assertPositiveMillicredits(input.amountMillicredits);
      const src = sourceType(input);
      const idempotencyKey =
        typeof input.metadata?.idempotencyKey === "string" ? input.metadata.idempotencyKey : null;
      const existing = transactions.find(
        (tx) =>
          tx.userId === input.userId &&
          tx.sourceType === src &&
          ((idempotencyKey && tx.metadata.idempotencyKey === idempotencyKey) ||
            (input.stripeSessionId && tx.metadata.stripeSessionId === input.stripeSessionId) ||
            (!!input.reason && tx.reason === input.reason)),
      );
      if (existing) return { transactionId: existing.id, created: false };
      const id = crypto.randomUUID();
      transactions.push({
        id,
        userId: input.userId,
        projectId: input.projectId,
        transactionType: src === "purchase" ? "purchase" : "grant",
        amountMillicredits: amount,
        sourceType: src,
        reason: input.reason ?? null,
        usageEventId: null,
        createdAt: new Date(),
        metadata: {
          source: input.source,
          sourceType: src,
          reason: input.reason ?? null,
          stripeSessionId: input.stripeSessionId ?? null,
          ...(input.metadata ?? {}),
        },
      });
      return { transactionId: id, created: true };
    },
    async debit(input: CreditDebitInput) {
      const amount = assertPositiveMillicredits(input.millicredits);
      const key = `${input.projectId}:${input.usageEventId}`;
      const existing = debitIds.get(key);
      if (existing) return { transactionId: existing };
      const id = crypto.randomUUID();
      transactions.push({
        id,
        userId: input.userId,
        projectId: input.projectId,
        transactionType: "consumption",
        amountMillicredits: -amount,
        sourceType: null,
        reason: null,
        usageEventId: input.usageEventId,
        createdAt: new Date(),
        metadata: {
          rootThreadId: input.rootThreadId,
          threadId: input.threadId,
          turnId: input.turnId,
          agentSlug: input.agentSlug,
          usageEventId: input.usageEventId,
        },
      });
      debitIds.set(key, id);
      return { transactionId: id };
    },
    async getBalance(input) {
      return transactions
        .filter((tx) => matches(tx, input))
        .reduce((sum, tx) => sum + tx.amountMillicredits, 0n)
        .toString();
    },
    async getBalanceBreakdown(input) {
      const scoped = transactions.filter((tx) => matches(tx, input));
      const sum = (source: string) =>
        scoped
          .filter((tx) => tx.sourceType === source)
          .reduce((total, tx) => total + tx.amountMillicredits, 0n);
      const consumed = scoped
        .filter((tx) => tx.amountMillicredits < 0n)
        .reduce((total, tx) => total - tx.amountMillicredits, 0n);
      const grants = sum("grant");
      const subs = sum("subscription");
      const purchases = sum("purchase");
      const total = grants + subs + purchases - consumed;
      const includedBudget = scoped
        .filter((tx) => tx.sourceType === "grant" || tx.sourceType === "subscription")
        .reduce((total, tx) => total + tx.amountMillicredits, 0n);
      const includedRemaining = grants + subs;
      const overage = total < 0n ? -total : 0n;
      const includedUsed = includedBudget - includedRemaining + overage;
      return {
        totalBalanceMillicredits: total.toString(),
        grantBalanceMillicredits: grants.toString(),
        subscriptionBalanceMillicredits: subs.toString(),
        purchasedBalanceMillicredits: purchases.toString(),
        debtBalanceMillicredits: (total < 0n ? total : 0n).toString(),
        includedBudgetMillicredits: includedBudget.toString(),
        includedUsedMillicredits: includedUsed.toString(),
        includedUsagePercent: usagePercent(includedUsed, includedBudget),
        canStartTurn: total >= 0n,
      };
    },
    async listTransactions(input) {
      return transactions
        .filter((tx) => matches(tx, input))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, input.limit ?? 50)
        .map(summary);
    },
    async getFreeGrantStatus(input) {
      const signup = transactions.find(
        (tx) => tx.userId === input.userId && tx.sourceType === "grant" && tx.reason === "signup",
      );
      const monthlyGranted = transactions.some(
        (tx) =>
          tx.userId === input.userId &&
          tx.sourceType === "grant" &&
          tx.reason === input.monthlyReason,
      );
      return { signupGrantedAt: signup?.createdAt.toISOString() ?? null, monthlyGranted };
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
