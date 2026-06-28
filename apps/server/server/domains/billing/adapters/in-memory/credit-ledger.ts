/** In-memory CreditLedger adapter for fast tests and local composition. */
import {
  assertPositiveMillicredits,
  type CreditDebitInput,
  type CreditGrantInput,
  type CreditLedger,
  type CreditLotView,
  type CreditTransactionRow,
} from "../../domain/credit-ledger.js";
import { displayReasonFor, grantIdentity, lotSourceForGrant } from "../../domain/grant-identity.js";

type LotSource = CreditLotView["source"];

type Lot = {
  id: string;
  userId: string;
  source: LotSource;
  originalMillicredits: bigint;
  balanceMillicredits: bigint;
  expiresAt: Date | null;
  stripeSessionId: string | null;
  idempotencyKey: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

type Tx = {
  id: string;
  userId: string;
  transactionType: string;
  amountMillicredits: bigint;
  sourceType: string | null;
  reason: string | null;
  usageEventId: string | null;
  createdAt: Date;
  metadata: Record<string, unknown>;
};

function unexpired(lot: Lot, now = new Date()): boolean {
  return lot.expiresAt === null || lot.expiresAt > now || lot.source === "debt";
}

function row(tx: Tx): CreditTransactionRow {
  return {
    id: tx.id,
    transactionType: tx.transactionType,
    amountMillicredits: tx.amountMillicredits.toString(),
    sourceType: tx.sourceType,
    reason: displayReasonFor({
      displayReason: typeof tx.metadata.reason === "string" ? tx.metadata.reason : null,
      sourceType: tx.sourceType,
      grantReason: tx.reason,
    }),
    usageEventId: tx.usageEventId,
    createdAt: tx.createdAt.toISOString(),
    metadata: tx.metadata,
  };
}

export function createInMemoryCreditLedger(initialTransactions: Tx[] = []): CreditLedger {
  const lots: Lot[] = [];
  const transactions = [...initialTransactions];
  const debitIds = new Map<string, string>();

  return {
    async grant(input: CreditGrantInput) {
      const amount = assertPositiveMillicredits(input.amountMillicredits);
      const identity = grantIdentity(input);
      const source = identity.sourceType;
      const existing = lots.find((lot) => {
        if (lot.userId !== input.userId || lot.source !== source) return false;
        if (source === "purchase" && identity.stripeSessionId !== null) {
          return lot.stripeSessionId === identity.stripeSessionId;
        }
        return identity.grantReason !== null && lot.reason === identity.grantReason;
      });
      if (existing) {
        const existingTx = transactions.find(
          (tx) => tx.userId === input.userId && tx.metadata.lotId === existing.id,
        );
        return { transactionId: existingTx?.id ?? existing.id, created: false };
      }

      const lotId = crypto.randomUUID();
      const transactionId = crypto.randomUUID();
      const createdAt = new Date();
      lots.push({
        id: lotId,
        userId: input.userId,
        source,
        originalMillicredits: amount,
        balanceMillicredits: amount,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        stripeSessionId: identity.stripeSessionId,
        idempotencyKey: input.stripeIdempotencyId ?? null,
        reason: identity.grantReason,
        metadata: {
          ...(input.metadata ?? {}),
          stripeIdempotencyId: input.stripeIdempotencyId ?? null,
        },
        createdAt,
      });
      transactions.push({
        id: transactionId,
        userId: input.userId,
        transactionType: source === "purchase" ? "purchase" : "grant",
        amountMillicredits: amount,
        sourceType: source,
        reason: identity.grantReason,
        usageEventId: null,
        createdAt,
        metadata: {
          ...(input.metadata ?? {}),
          lotId,
          source: input.source,
          sourceType: source,
          reason: input.displayReason ?? null,
          stripeSessionId: input.stripeSessionId ?? null,
          stripeIdempotencyId: input.stripeIdempotencyId ?? null,
        },
      });
      return { transactionId, created: true };
    },

    async debit(input: CreditDebitInput) {
      const amount = assertPositiveMillicredits(input.millicredits);
      const key = `${input.userId}:${input.usageEventId}`;
      const existing = debitIds.get(key);
      if (existing) return { transactionId: existing };

      const consumptionGroupId = crypto.randomUUID();
      let remaining = amount;
      const spendable = lots
        .filter(
          (lot) => lot.userId === input.userId && unexpired(lot) && lot.balanceMillicredits > 0n,
        )
        .sort((a, b) => {
          const aExpiry = a.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
          const bExpiry = b.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
          return aExpiry - bExpiry || a.createdAt.getTime() - b.createdAt.getTime();
        });

      for (const lot of spendable) {
        if (remaining === 0n) break;
        const consumed = lot.balanceMillicredits < remaining ? lot.balanceMillicredits : remaining;
        lot.balanceMillicredits -= consumed;
        remaining -= consumed;
      }

      if (remaining > 0n) {
        let debt = lots.find((lot) => lot.userId === input.userId && lot.source === "debt");
        if (!debt) {
          debt = {
            id: crypto.randomUUID(),
            userId: input.userId,
            source: "debt",
            originalMillicredits: remaining,
            balanceMillicredits: 0n,
            expiresAt: null,
            stripeSessionId: null,
            idempotencyKey: null,
            reason: null,
            metadata: {},
            createdAt: new Date(),
          };
          lots.push(debt);
        }
        debt.originalMillicredits += remaining;
        debt.balanceMillicredits -= remaining;
      }

      transactions.push({
        id: consumptionGroupId,
        userId: input.userId,
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
      debitIds.set(key, consumptionGroupId);
      return { transactionId: consumptionGroupId };
    },

    async getBalance(input) {
      return lots
        .filter((lot) => lot.userId === input.userId && unexpired(lot))
        .reduce((sum, lot) => sum + lot.balanceMillicredits, 0n)
        .toString();
    },

    async getBalanceBreakdown(input) {
      return {
        lots: lots
          .filter((lot) => lot.userId === input.userId && unexpired(lot))
          .map((lot) => ({
            source: lot.source,
            balanceMillicredits: lot.balanceMillicredits.toString(),
            originalMillicredits: lot.originalMillicredits.toString(),
            expiresAt: lot.expiresAt?.toISOString() ?? null,
            grantReason: lot.reason,
          })),
      };
    },

    async listTransactions(input) {
      return transactions
        .filter((tx) => tx.userId === input.userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, input.limit ?? 50)
        .map(row);
    },

    async getThreadDebitTotal(input) {
      return transactions
        .filter(
          (tx) =>
            tx.userId === input.userId &&
            tx.metadata.threadId === input.threadId &&
            tx.amountMillicredits < 0n,
        )
        .reduce((sum, tx) => sum - tx.amountMillicredits, 0n)
        .toString();
    },

    async hasUnexpiredLot(input) {
      const source = lotSourceForGrant(input.source);
      const now = new Date();
      return lots.some((lot) => {
        if (lot.userId !== input.userId || lot.source !== source) return false;
        if (input.source === "free" && !lot.reason?.startsWith("free_tier_")) return false;
        if (source === "subscription") return lot.expiresAt !== null && lot.expiresAt > now;
        return lot.expiresAt === null || lot.expiresAt > now;
      });
    },
  };
}
