/** Drizzle/Postgres CreditLedger adapter over credit_lots and credit_transactions. */
import type { Database } from "@meridian/database";
import { creditLots, creditTransactions } from "@meridian/database/schema";
import { and, desc, eq, like, type SQL, sql } from "drizzle-orm";
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
  type CreditLotView,
} from "../../domain/credit-ledger.js";

type ActiveDb = ReturnType<typeof currentDrizzleDb>;
type LotSource = CreditLotView["source"];

function activeDb(db: Database): ActiveDb {
  return currentDrizzleDb(db as never);
}

function sourceTypeForGrant(source: CreditGrantSource): "grant" | "purchase" | "subscription" {
  if (source === "stripe") return "purchase";
  if (source === "subscription") return "subscription";
  return "grant";
}

function sourceTypeForLookup(source: CreditGrantSource): "grant" | "purchase" | "subscription" {
  return sourceTypeForGrant(source);
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

function nullableIso(value: unknown): string | null {
  if (value == null) return null;
  return iso(value);
}

function displayTransactionReason(input: {
  metadata: unknown;
  lotReason: string | null;
  sourceType: string | null;
}): string | null {
  const metadata =
    input.metadata && typeof input.metadata === "object"
      ? (input.metadata as Record<string, unknown>)
      : {};
  const metadataReason = metadata.reason;
  if (typeof metadataReason === "string" && metadataReason.length > 0) return metadataReason;
  if (input.sourceType === "grant" && input.lotReason?.startsWith("free_tier_")) {
    return "Monthly usage";
  }
  return input.lotReason;
}

interface GrantIdentity {
  sourceType: "grant" | "purchase" | "subscription";
  grantReason: string | null;
  stripeSessionId: string | null;
}

function grantIdentity(input: CreditGrantInput): GrantIdentity {
  const sourceType = sourceTypeForGrant(input.source);
  return {
    sourceType,
    grantReason:
      sourceType === "purchase" ? null : (input.stripeIdempotencyId ?? input.reason ?? null),
    stripeSessionId:
      sourceType === "purchase"
        ? (input.stripeSessionId ?? input.stripeIdempotencyId ?? null)
        : (input.stripeSessionId ?? null),
  };
}

interface LotConflictGuard {
  target: IndexColumn | IndexColumn[];
  where: SQL;
}

function resolveLotConflictGuard(identity: GrantIdentity): LotConflictGuard | null {
  if (identity.sourceType === "purchase" && identity.stripeSessionId) {
    return {
      target: creditLots.stripeSessionId,
      where: sql`${creditLots.stripeSessionId} IS NOT NULL`,
    };
  }
  if (identity.sourceType === "subscription" && identity.grantReason) {
    return {
      target: [creditLots.userId, creditLots.grantReason],
      where: sql`${creditLots.sourceType} = 'subscription' AND ${creditLots.grantReason} IS NOT NULL`,
    };
  }
  if (identity.sourceType === "grant" && identity.grantReason === "signup") {
    return {
      target: [creditLots.userId, creditLots.grantReason],
      where: sql`${creditLots.grantReason} = 'signup'`,
    };
  }
  if (identity.sourceType === "grant" && identity.grantReason?.startsWith("monthly_")) {
    return {
      target: [creditLots.userId, creditLots.grantReason],
      where: sql`${creditLots.grantReason} LIKE 'monthly_%'`,
    };
  }
  if (identity.sourceType === "grant" && identity.grantReason?.startsWith("free_tier_")) {
    return {
      target: [creditLots.userId, creditLots.grantReason],
      where:
        and(eq(creditLots.sourceType, "grant"), like(creditLots.grantReason, "free_tier_%")) ??
        sql`${creditLots.sourceType} = 'grant' AND ${creditLots.grantReason} LIKE 'free_tier_%'`,
    };
  }
  return null;
}

async function findExistingGrantTransaction(
  tx: ActiveDb,
  input: { userId: string } & GrantIdentity,
): Promise<string | null> {
  const predicates = [
    eq(creditTransactions.userId, input.userId),
    eq(creditLots.sourceType, input.sourceType),
  ];
  if (input.sourceType === "purchase" && input.stripeSessionId) {
    predicates.push(eq(creditLots.stripeSessionId, input.stripeSessionId));
  } else if (input.grantReason) {
    predicates.push(eq(creditLots.grantReason, input.grantReason));
  } else {
    return null;
  }

  const [existing] = await tx
    .select({ id: creditTransactions.id })
    .from(creditTransactions)
    .leftJoin(creditLots, eq(creditTransactions.lotId, creditLots.id))
    .where(and(...predicates))
    .limit(1);
  return existing?.id ?? null;
}

async function findIdempotentLot(
  tx: ActiveDb,
  input: { userId: string } & GrantIdentity,
): Promise<{ id: string } | null> {
  const predicates = [
    eq(creditLots.userId, input.userId),
    eq(creditLots.sourceType, input.sourceType),
  ];
  if (input.sourceType === "purchase" && input.stripeSessionId) {
    predicates.push(eq(creditLots.stripeSessionId, input.stripeSessionId));
  } else if (input.grantReason) {
    predicates.push(eq(creditLots.grantReason, input.grantReason));
  } else {
    return null;
  }

  const [existing] = await tx
    .select({ id: creditLots.id })
    .from(creditLots)
    .where(and(...predicates))
    .limit(1);
  return existing ?? null;
}

export function createDrizzleCreditLedger(db: Database): CreditLedger {
  return {
    async grant(input: CreditGrantInput) {
      return runInDrizzleTransaction(db as never, async () => {
        const amount = assertPositiveMillicredits(input.amountMillicredits);
        const tx = activeDb(db);
        const identity = grantIdentity(input);
        const existingTransactionId = await findExistingGrantTransaction(tx, {
          userId: input.userId,
          ...identity,
        });
        if (existingTransactionId) return { transactionId: existingTransactionId, created: false };

        const values = {
          userId: input.userId,
          sourceType: identity.sourceType,
          originalAmountMillicredits: Number(amount),
          remainingMillicredits: Number(amount),
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          stripeSessionId: identity.stripeSessionId,
          grantReason: identity.grantReason,
          metadata: {
            stripeIdempotencyId: input.stripeIdempotencyId ?? null,
            ...(input.metadata ?? {}),
          },
        };
        const guard = resolveLotConflictGuard(identity);
        const builder = tx.insert(creditLots).values(values);
        const [lot] = await (guard ? builder.onConflictDoNothing(guard) : builder).returning({
          id: creditLots.id,
        });
        const lotId = lot?.id;
        if (!lotId) {
          const racedTransactionId = await findExistingGrantTransaction(tx, {
            userId: input.userId,
            ...identity,
          });
          if (racedTransactionId) return { transactionId: racedTransactionId, created: false };
          const existingLot = await findIdempotentLot(tx, { userId: input.userId, ...identity });
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
            transactionType: identity.sourceType === "purchase" ? "purchase" : "grant",
            amountMillicredits: Number(amount),
            lotId,
            metadata: {
              source: input.source,
              sourceType: identity.sourceType,
              reason: input.reason ?? null,
              stripeSessionId: input.stripeSessionId ?? null,
              stripeIdempotencyId: input.stripeIdempotencyId ?? null,
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
        consumption_group_id: string;
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
      if (!row) throw new Error("Failed to create or find credit debit transaction");
      return { transactionId: row.consumption_group_id };
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
      const rows = await activeDb(db)
        .select({
          source: creditLots.sourceType,
          balanceMillicredits: creditLots.remainingMillicredits,
          originalMillicredits: creditLots.originalAmountMillicredits,
          expiresAt: creditLots.expiresAt,
          grantReason: creditLots.grantReason,
        })
        .from(creditLots)
        .where(
          and(
            eq(creditLots.userId, input.userId),
            sql`(${creditLots.expiresAt} IS NULL OR ${creditLots.expiresAt} > NOW() OR ${creditLots.sourceType} = 'debt')`,
          ),
        )
        .orderBy(creditLots.expiresAt, creditLots.createdAt);
      return {
        lots: rows.map((row) => ({
          source: row.source as LotSource,
          balanceMillicredits: toBigInt(row.balanceMillicredits).toString(),
          originalMillicredits: toBigInt(row.originalMillicredits).toString(),
          expiresAt: nullableIso(row.expiresAt),
          grantReason: row.grantReason ?? null,
        })),
      };
    },

    async listTransactions(input) {
      const rows = await activeDb(db)
        .select({
          id: creditTransactions.id,
          transactionType: creditTransactions.transactionType,
          amountMillicredits: creditTransactions.amountMillicredits,
          sourceType: creditLots.sourceType,
          lotReason: creditLots.grantReason,
          usageEventId: creditTransactions.usageEventId,
          createdAt: creditTransactions.createdAt,
          metadata: creditTransactions.metadata,
        })
        .from(creditTransactions)
        .leftJoin(creditLots, eq(creditTransactions.lotId, creditLots.id))
        .where(eq(creditTransactions.userId, input.userId))
        .orderBy(desc(creditTransactions.createdAt))
        .limit(input.limit ?? 50);
      return rows.map((row) => ({
        id: row.id,
        transactionType: row.transactionType,
        amountMillicredits: toBigInt(row.amountMillicredits).toString(),
        sourceType: row.sourceType ?? null,
        reason: displayTransactionReason({
          metadata: row.metadata,
          lotReason: row.lotReason ?? null,
          sourceType: row.sourceType ?? null,
        }),
        usageEventId: row.usageEventId ?? null,
        createdAt: iso(row.createdAt),
        metadata: (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<
          string,
          unknown
        >,
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

    async hasUnexpiredLot(input) {
      const sourceType = sourceTypeForLookup(input.source);
      const expiryPredicate =
        sourceType === "subscription"
          ? sql`${creditLots.expiresAt} > NOW()`
          : sql`(${creditLots.expiresAt} IS NULL OR ${creditLots.expiresAt} > NOW())`;
      const freeTierPredicate =
        input.source === "free"
          ? and(eq(creditLots.sourceType, "grant"), like(creditLots.grantReason, "free_tier_%"))
          : undefined;
      const [row] = await activeDb(db)
        .select({ id: creditLots.id })
        .from(creditLots)
        .where(
          and(
            eq(creditLots.userId, input.userId),
            eq(creditLots.sourceType, sourceType),
            expiryPredicate,
            freeTierPredicate,
          ),
        )
        .limit(1);
      return Boolean(row);
    },
  };
}
