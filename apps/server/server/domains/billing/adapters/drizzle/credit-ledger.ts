// @ts-nocheck
/**
 * Purpose: Drizzle/Postgres implementation of the workbench credit ledger.
 * Key decisions: the lot model is the single money truth. Grants create credit
 * lots; model-call debits consume those lots FIFO, decrement
 * remaining_millicredits, and write lot-linked transaction rows. A separate
 * usage-event fence gives idempotency without preventing one debit from
 * touching multiple lots.
 */
import type { Database } from "@meridian/database";
import { creditLots, creditTransactions } from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../../shared/drizzle-transaction.js";
import {
  assertPositiveMillicredits,
  type CreditDebitInput,
  type CreditGrantInput,
  type CreditGrantSource,
  type CreditLedger,
} from "../../domain/credit-ledger.js";

function activeDb(db: Database): Database {
  return currentDrizzleDb(db);
}

function jsonText(path: string) {
  return sql<string>`${creditTransactions.metadata}->>${path}`;
}

function sourceTypeForGrant(source: CreditGrantSource): "grant" | "purchase" | "subscription" {
  if (source === "manual") return "grant";
  if (source === "stripe") return "purchase";
  return source;
}

export function createDrizzleCreditLedger(db: Database): CreditLedger {
  return {
    async grant(input: CreditGrantInput) {
      const amount = assertPositiveMillicredits(input.amountMillicredits);
      const tx = activeDb(db);
      const [lot] = await tx
        .insert(creditLots)
        .values({
          userId: input.userId,
          workbenchId: input.workbenchId,
          sourceType: sourceTypeForGrant(input.source),
          originalAmountMillicredits: amount,
          remainingMillicredits: amount,
          grantReason: input.reason ?? null,
          metadata: input.metadata ?? {},
        })
        .returning({ id: creditLots.id });
      if (!lot) throw new Error("Failed to create credit lot");
      const [transaction] = await tx
        .insert(creditTransactions)
        .values({
          userId: input.userId,
          workbenchId: input.workbenchId,
          transactionType: "grant",
          amountMillicredits: amount,
          lotId: lot.id,
          metadata: {
            source: input.source,
            sourceType: sourceTypeForGrant(input.source),
            reason: input.reason ?? null,
            ...(input.metadata ?? {}),
          },
        })
        .returning({ id: creditTransactions.id });
      if (!transaction) throw new Error("Failed to create credit grant transaction");
      return { transactionId: transaction.id };
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
        transaction_id: string | null;
        remaining_balance: bigint;
        went_negative: boolean;
        already_consumed: boolean;
      }>(sql`
        SELECT *
        FROM consume_credit_lots_fifo(
          ${input.userId}::uuid,
          ${input.workbenchId}::uuid,
          ${amount},
          ${consumptionGroupId}::uuid,
          ${input.usageEventId},
          ${metadata}::jsonb
        )
      `);
      const row = rows[0];
      if (!row?.transaction_id) {
        throw new Error("Failed to create or find credit debit transaction");
      }
      return { transactionId: row.transaction_id };
    },

    async getBalance(input) {
      const [row] = await activeDb(db)
        .select({ total: sql<bigint>`COALESCE(SUM(${creditLots.remainingMillicredits}), 0)` })
        .from(creditLots)
        .where(
          and(
            eq(creditLots.userId, input.userId),
            eq(creditLots.workbenchId, input.workbenchId),
            sql`(${creditLots.expiresAt} IS NULL OR ${creditLots.expiresAt} > NOW() OR ${creditLots.sourceType} = 'debt')`,
          ),
        );
      return (row?.total ?? 0n).toString();
    },

    async getRunDebitTotal(input) {
      const [row] = await activeDb(db)
        .select({ total: sql<bigint>`COALESCE(SUM(-${creditTransactions.amountMillicredits}), 0)` })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.userId, input.userId),
            eq(creditTransactions.workbenchId, input.workbenchId),
            sql`${creditTransactions.amountMillicredits} < 0`,
            sql`${creditTransactions.metadata}->>'rootThreadId' = ${input.rootThreadId}`,
          ),
        );
      return (row?.total ?? 0n).toString();
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
            eq(creditTransactions.workbenchId, input.workbenchId),
            sql`${creditTransactions.amountMillicredits} < 0`,
            sql`${creditTransactions.metadata}->>'rootThreadId' = ${input.rootThreadId}`,
          ),
        )
        .groupBy(sql`${creditTransactions.metadata}->>'agentSlug'`);
      return rows.map((row) => ({
        agentSlug: row.agentSlug ?? "unknown",
        millicredits: row.total.toString(),
      }));
    },

    async getThreadDebitTotal(input) {
      const [row] = await activeDb(db)
        .select({ total: sql<bigint>`COALESCE(SUM(-${creditTransactions.amountMillicredits}), 0)` })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.userId, input.userId),
            eq(creditTransactions.workbenchId, input.workbenchId),
            sql`${creditTransactions.amountMillicredits} < 0`,
            sql`${creditTransactions.metadata}->>'threadId' = ${input.threadId}`,
          ),
        );
      return (row?.total ?? 0n).toString();
    },
  };
}
