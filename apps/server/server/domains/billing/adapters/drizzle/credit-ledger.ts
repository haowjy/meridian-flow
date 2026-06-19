/**
 * Purpose: Drizzle/Postgres implementation of the project credit ledger.
 * Key decisions: the lot model is the single money truth. Grants create credit
 * lots; model-call debits consume those lots FIFO, decrement
 * remaining_millicredits, and write lot-linked transaction rows. A separate
 * usage-event fence gives idempotency without preventing one debit from
 * touching multiple lots.
 */
import type { Database } from "@meridian/database";
import { creditLots, creditTransactions } from "@meridian/database/schema";
import { and, eq, type SQL, sql } from "drizzle-orm";
import type { IndexColumn } from "drizzle-orm/pg-core";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
} from "../../../../shared/drizzle-transaction.js";
import {
  assertPositiveMillicredits,
  type CreditDebitInput,
  type CreditGrantInput,
  type CreditGrantSource,
  type CreditLedger,
  usagePercent,
} from "../../domain/credit-ledger.js";

type ActiveDb = ReturnType<typeof currentDrizzleDb>;
function activeDb(db: Database): ActiveDb {
  return currentDrizzleDb(db as never);
}

function jsonText(path: string) {
  return sql<string>`${creditTransactions.metadata}->>${path}`;
}

function sourceTypeForGrant(source: CreditGrantSource): "grant" | "purchase" | "subscription" {
  if (source === "manual") return "grant";
  if (source === "stripe") return "purchase";
  return source;
}
function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  return 0n;
}
function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

interface LotConflictGuard {
  target: IndexColumn | IndexColumn[];
  where: SQL;
}

/**
 * The idempotency guard a credit-lot insert rides on `onConflictDoNothing`:
 * which unique index plus the partial-index predicate it must match. One guard
 * per grant family (subscription period, Stripe purchase session, signup grant,
 * monthly grant). Manual / ad-hoc grants have no idempotency key → `null` (plain
 * insert). Keeping the dispatch here collapses what was a 5-arm nested ternary
 * around the insert into one decision + one insert site.
 */
function resolveLotConflictGuard(
  src: "grant" | "purchase" | "subscription",
  input: Pick<CreditGrantInput, "reason" | "stripeSessionId">,
): LotConflictGuard | null {
  if (src === "subscription" && input.reason) {
    return {
      target: [creditLots.userId, creditLots.grantReason],
      where: sql`${creditLots.sourceType} = 'subscription' AND ${creditLots.grantReason} IS NOT NULL`,
    };
  }
  if (src === "purchase" && input.stripeSessionId) {
    return {
      target: creditLots.stripeSessionId,
      where: sql`${creditLots.stripeSessionId} IS NOT NULL`,
    };
  }
  if (src === "grant" && input.reason === "signup") {
    return {
      target: [creditLots.userId, creditLots.grantReason],
      where: sql`${creditLots.grantReason} = 'signup'`,
    };
  }
  if (src === "grant" && input.reason?.startsWith("monthly_")) {
    return {
      target: [creditLots.userId, creditLots.grantReason],
      where: sql`${creditLots.grantReason} LIKE 'monthly_%'`,
    };
  }
  return null;
}

async function findExistingGrantTransaction(
  tx: ActiveDb,
  input: {
    userId: string;
    sourceType: "grant" | "purchase" | "subscription";
    reason: string | null;
    stripeSessionId: string | null;
  },
): Promise<string | null> {
  if (input.sourceType === "subscription" && input.reason) {
    const [existing] = await tx
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .leftJoin(creditLots, eq(creditTransactions.lotId, creditLots.id))
      .where(
        and(
          eq(creditTransactions.userId, input.userId),
          eq(creditLots.sourceType, input.sourceType),
          eq(creditLots.grantReason, input.reason),
        ),
      )
      .limit(1);
    return existing?.id ?? null;
  }

  if (input.sourceType === "purchase" && input.stripeSessionId) {
    const [existing] = await tx
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .leftJoin(creditLots, eq(creditTransactions.lotId, creditLots.id))
      .where(
        and(
          eq(creditTransactions.userId, input.userId),
          eq(creditLots.sourceType, input.sourceType),
          eq(creditLots.stripeSessionId, input.stripeSessionId),
        ),
      )
      .limit(1);
    return existing?.id ?? null;
  }

  if (input.sourceType === "grant" && input.reason) {
    const [existing] = await tx
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .leftJoin(creditLots, eq(creditTransactions.lotId, creditLots.id))
      .where(
        and(
          eq(creditTransactions.userId, input.userId),
          eq(creditLots.sourceType, "grant"),
          eq(creditLots.grantReason, input.reason),
        ),
      )
      .limit(1);
    return existing?.id ?? null;
  }

  return null;
}

async function findIdempotentLot(
  tx: ActiveDb,
  input: {
    userId: string;
    sourceType: "grant" | "purchase" | "subscription";
    reason: string | null;
    stripeSessionId: string | null;
  },
): Promise<{ id: string } | null> {
  if (input.sourceType === "subscription" && input.reason) {
    const [existing] = await tx
      .select({ id: creditLots.id })
      .from(creditLots)
      .where(
        and(
          eq(creditLots.userId, input.userId),
          eq(creditLots.sourceType, "subscription"),
          eq(creditLots.grantReason, input.reason),
        ),
      )
      .limit(1);
    return existing ?? null;
  }

  if (input.sourceType === "purchase" && input.stripeSessionId) {
    const [existing] = await tx
      .select({ id: creditLots.id })
      .from(creditLots)
      .where(
        and(
          eq(creditLots.userId, input.userId),
          eq(creditLots.sourceType, "purchase"),
          eq(creditLots.stripeSessionId, input.stripeSessionId),
        ),
      )
      .limit(1);
    return existing ?? null;
  }

  if (input.sourceType === "grant" && input.reason) {
    const [existing] = await tx
      .select({ id: creditLots.id })
      .from(creditLots)
      .where(
        and(
          eq(creditLots.userId, input.userId),
          eq(creditLots.sourceType, "grant"),
          eq(creditLots.grantReason, input.reason),
        ),
      )
      .limit(1);
    return existing ?? null;
  }

  return null;
}

export function createDrizzleCreditLedger(db: Database): CreditLedger {
  return {
    async grant(input: CreditGrantInput) {
      return runInDrizzleTransaction(db as never, async () => {
        const amount = assertPositiveMillicredits(input.amountMillicredits);
        const tx = activeDb(db);
        const src = sourceTypeForGrant(input.source);
        const existingTransactionId = await findExistingGrantTransaction(tx, {
          userId: input.userId,
          sourceType: src,
          reason: input.reason ?? null,
          stripeSessionId: input.stripeSessionId ?? null,
        });
        if (existingTransactionId) return { transactionId: existingTransactionId, created: false };

        const values = {
          userId: input.userId,
          sourceType: src,
          originalAmountMillicredits: Number(amount),
          remainingMillicredits: Number(amount),
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          stripeSessionId: input.stripeSessionId ?? null,
          grantReason: input.reason ?? null,
          metadata: input.metadata ?? {},
        };
        const guard = resolveLotConflictGuard(src, input);
        const builder = tx.insert(creditLots).values(values);
        const [lot] = await (guard ? builder.onConflictDoNothing(guard) : builder).returning({
          id: creditLots.id,
        });
        const lotId = lot?.id;
        if (!lotId) {
          const racedTransactionId = await findExistingGrantTransaction(tx, {
            userId: input.userId,
            sourceType: src,
            reason: input.reason ?? null,
            stripeSessionId: input.stripeSessionId ?? null,
          });
          if (racedTransactionId) return { transactionId: racedTransactionId, created: false };
          const existingLot = await findIdempotentLot(tx, {
            userId: input.userId,
            sourceType: src,
            reason: input.reason ?? null,
            stripeSessionId: input.stripeSessionId ?? null,
          });
          if (existingLot) {
            const [existingTransaction] = await tx
              .select({ id: creditTransactions.id })
              .from(creditTransactions)
              .where(
                and(
                  eq(creditTransactions.userId, input.userId),
                  eq(creditTransactions.lotId, existingLot.id),
                ),
              )
              .limit(1);
            if (existingTransaction) {
              return { transactionId: existingTransaction.id, created: false };
            }
          }
        }
        if (!lotId) throw new Error("Failed to create credit lot");
        const [transaction] = await tx
          .insert(creditTransactions)
          .values({
            userId: input.userId,
            transactionType: src === "purchase" ? "purchase" : "grant",
            amountMillicredits: Number(amount),
            lotId,
            metadata: {
              source: input.source,
              sourceType: sourceTypeForGrant(input.source),
              reason: input.reason ?? null,
              ...(input.metadata ?? {}),
            },
          })
          .returning({ id: creditTransactions.id });
        if (!transaction) throw new Error("Failed to create credit grant transaction");
        return { transactionId: transaction.id, created: true };
      });
    },

    async debit(input: CreditDebitInput) {
      const amount = assertPositiveMillicredits(input.millicredits);
      const tx = activeDb(db);
      const [existing] = await tx
        .select({ consumptionGroupId: creditTransactions.consumptionGroupId })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.userId, input.userId),
            eq(creditTransactions.transactionType, "consumption"),
            eq(creditTransactions.usageEventId, input.usageEventId),
          ),
        )
        .limit(1);
      if (existing?.consumptionGroupId) {
        return { transactionId: existing.consumptionGroupId };
      }
      const consumptionGroupId = crypto.randomUUID();
      const metadata = JSON.stringify({
        rootThreadId: input.rootThreadId,
        threadId: input.threadId,
        turnId: input.turnId,
        agentSlug: input.agentSlug,
      });
      const rows = await tx.execute<{
        remaining_balance: bigint;
        went_negative: boolean;
      }>(sql`
        SELECT *
        FROM consume_credit_lots_fifo(
          ${input.userId}::uuid,
          ${amount},
          ${consumptionGroupId}::uuid,
          ${input.usageEventId},
          ${metadata}::jsonb
        )
      `);
      const row = rows[0];
      if (!row) {
        throw new Error("Failed to create or find credit debit transaction");
      }
      return { transactionId: consumptionGroupId };
    },

    async getBalance(input) {
      const [row] = await activeDb(db)
        .select({ total: sql<bigint>`COALESCE(SUM(${creditLots.remainingMillicredits}), 0)` })
        .from(creditLots)
        .where(
          and(
            eq(creditLots.userId, input.userId),
            sql`(${creditLots.expiresAt} IS NULL OR ${creditLots.expiresAt} > NOW() OR ${creditLots.sourceType} = 'debt')`,
          ),
        );
      return toBigInt(row?.total).toString();
    },

    async getBalanceBreakdown(input) {
      const [row] = await activeDb(db)
        .select({
          total: sql<bigint>`COALESCE(SUM(${creditLots.remainingMillicredits}), 0)`,
          grant: sql<bigint>`COALESCE(SUM(${creditLots.remainingMillicredits}) FILTER (WHERE ${creditLots.sourceType} = 'grant'), 0)`,
          subscription: sql<bigint>`COALESCE(SUM(${creditLots.remainingMillicredits}) FILTER (WHERE ${creditLots.sourceType} = 'subscription'), 0)`,
          purchase: sql<bigint>`COALESCE(SUM(${creditLots.remainingMillicredits}) FILTER (WHERE ${creditLots.sourceType} = 'purchase'), 0)`,
          debt: sql<bigint>`COALESCE(SUM(${creditLots.remainingMillicredits}) FILTER (WHERE ${creditLots.sourceType} = 'debt'), 0)`,
          includedBudget: sql<bigint>`COALESCE(SUM(${creditLots.originalAmountMillicredits}) FILTER (WHERE ${creditLots.sourceType} IN ('grant', 'subscription')), 0)`,
          includedRemaining: sql<bigint>`COALESCE(SUM(${creditLots.remainingMillicredits}) FILTER (WHERE ${creditLots.sourceType} IN ('grant', 'subscription')), 0)`,
        })
        .from(creditLots)
        .where(
          and(
            eq(creditLots.userId, input.userId),
            sql`(${creditLots.expiresAt} IS NULL OR ${creditLots.expiresAt} > NOW() OR ${creditLots.sourceType} = 'debt')`,
          ),
        );
      const total = toBigInt(row?.total);
      const budget = toBigInt(row?.includedBudget);
      const remaining = toBigInt(row?.includedRemaining);
      const used = budget - remaining + (total < 0n ? -total : 0n);
      return {
        totalBalanceMillicredits: total.toString(),
        grantBalanceMillicredits: toBigInt(row?.grant).toString(),
        subscriptionBalanceMillicredits: toBigInt(row?.subscription).toString(),
        purchasedBalanceMillicredits: toBigInt(row?.purchase).toString(),
        debtBalanceMillicredits: toBigInt(row?.debt).toString(),
        includedBudgetMillicredits: budget.toString(),
        includedUsedMillicredits: used.toString(),
        includedUsagePercent: usagePercent(used, budget),
        canStartTurn: total >= 0n,
      };
    },

    async listTransactions(input) {
      const rows = await activeDb(db)
        .select({
          id: creditTransactions.id,
          transactionType: creditTransactions.transactionType,
          amountMillicredits: creditTransactions.amountMillicredits,
          sourceType: creditLots.sourceType,
          reason: creditLots.grantReason,
          usageEventId: creditTransactions.usageEventId,
          createdAt: creditTransactions.createdAt,
          metadata: creditTransactions.metadata,
        })
        .from(creditTransactions)
        .leftJoin(creditLots, eq(creditTransactions.lotId, creditLots.id))
        .where(eq(creditTransactions.userId, input.userId))
        .orderBy(creditTransactions.createdAt)
        .limit(input.limit ?? 50);
      return rows.map((row) => ({
        id: row.id,
        transactionType: row.transactionType,
        amountMillicredits: toBigInt(row.amountMillicredits).toString(),
        sourceType: row.sourceType ?? null,
        reason: row.reason ?? null,
        usageEventId: row.usageEventId ?? null,
        createdAt: iso(row.createdAt),
        metadata: (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<
          string,
          unknown
        >,
      }));
    },

    async getFreeGrantStatus(input) {
      const rows = await activeDb(db)
        .select({ reason: creditLots.grantReason, createdAt: creditLots.createdAt })
        .from(creditLots)
        .where(and(eq(creditLots.userId, input.userId), eq(creditLots.sourceType, "grant")));
      const signup = rows.find((row) => row.reason === "signup");
      return {
        signupGrantedAt: signup ? iso(signup.createdAt) : null,
        monthlyGranted: rows.some((row) => row.reason === input.monthlyReason),
      };
    },

    async getRunDebitTotal(input) {
      const [row] = await activeDb(db)
        .select({ total: sql<bigint>`COALESCE(SUM(-${creditTransactions.amountMillicredits}), 0)` })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.userId, input.userId),
            sql`${creditTransactions.amountMillicredits} < 0`,
            sql`${creditTransactions.metadata}->>'rootThreadId' = ${input.rootThreadId}`,
          ),
        );
      return toBigInt(row?.total).toString();
    },

    async getAgentDebitTotals(input) {
      const rows = await activeDb(db)
        .select({
          agentSlug: jsonText("agentSlug"),
          total: sql<bigint>`COALESCE(SUM(-${creditTransactions.amountMillicredits}), 0)`,
        })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.userId, input.userId),
            sql`${creditTransactions.amountMillicredits} < 0`,
            sql`${creditTransactions.metadata}->>'rootThreadId' = ${input.rootThreadId}`,
          ),
        )
        .groupBy(sql`${creditTransactions.metadata}->>'agentSlug'`);
      return rows.map((row) => ({
        agentSlug: row.agentSlug ?? "unknown",
        millicredits: toBigInt(row.total).toString(),
      }));
    },

    async getThreadDebitTotal(input) {
      const [row] = await activeDb(db)
        .select({ total: sql<bigint>`COALESCE(SUM(-${creditTransactions.amountMillicredits}), 0)` })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.userId, input.userId),
            sql`${creditTransactions.amountMillicredits} < 0`,
            sql`${creditTransactions.metadata}->>'threadId' = ${input.threadId}`,
          ),
        );
      return toBigInt(row?.total).toString();
    },
  };
}
