import type { Database } from "@meridian/database";
import { userSubscriptions } from "@meridian/database/schema";
import { and, eq, gt, inArray, lt, lte, or, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../../shared/drizzle-transaction.js";
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  isMonotonicReplacement,
} from "../../domain/subscription-policy.js";
import type {
  SubscriptionRecord,
  SubscriptionStore,
  SubscriptionUpsertInput,
} from "../../ports/subscription-store.js";

function activeDb(db: Database) {
  return currentDrizzleDb(db as never);
}

function toRecord(row: typeof userSubscriptions.$inferSelect): SubscriptionRecord {
  return {
    id: row.id,
    userId: row.userId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    stripeCustomerId: row.stripeCustomerId,
    plan: row.plan as SubscriptionRecord["plan"],
    status: row.status as SubscriptionRecord["status"],
    creditsPerPeriod: String(row.creditsPerPeriod),
    currentPeriodStart: row.currentPeriodStart.toISOString(),
    currentPeriodEnd: row.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
  };
}

function monotonicUpdateWhere(input: SubscriptionUpsertInput) {
  // Typed comparators (lt/eq) encode the Date through the timestamp column so
  // postgres-js receives an ISO string; a raw `sql` fragment would bind the
  // Date object directly and throw ERR_INVALID_ARG_TYPE.
  const inputStart = new Date(input.currentPeriodStart);
  return or(
    lt(userSubscriptions.currentPeriodStart, inputStart),
    and(
      eq(userSubscriptions.currentPeriodStart, inputStart),
      sql`NOT (${userSubscriptions.status} = 'cancelled' AND ${input.status} <> 'cancelled')`,
    ),
  );
}

export function createDrizzleSubscriptionStore(db: Database): SubscriptionStore {
  return {
    async upsert(input: SubscriptionUpsertInput) {
      const tx = activeDb(db);
      const [existingRow] = await tx
        .select()
        .from(userSubscriptions)
        .where(eq(userSubscriptions.stripeSubscriptionId, input.stripeSubscriptionId))
        .limit(1);
      const existing = existingRow ? toRecord(existingRow) : null;
      if (existing && !isMonotonicReplacement(existing, input)) return existing;
      const inputStart = new Date(input.currentPeriodStart);
      if (input.status !== "cancelled") {
        const [newerActiveForUser] = await tx
          .select()
          .from(userSubscriptions)
          .where(
            and(
              eq(userSubscriptions.userId, input.userId),
              inArray(userSubscriptions.status, [...ACTIVE_SUBSCRIPTION_STATUSES]),
              sql`${userSubscriptions.stripeSubscriptionId} <> ${input.stripeSubscriptionId}`,
              gt(userSubscriptions.currentPeriodStart, inputStart),
            ),
          )
          .limit(1);
        if (newerActiveForUser) return toRecord(newerActiveForUser);
      }

      if (input.status !== "cancelled") {
        await tx
          .update(userSubscriptions)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(
            and(
              eq(userSubscriptions.userId, input.userId),
              inArray(userSubscriptions.status, [...ACTIVE_SUBSCRIPTION_STATUSES]),
              sql`${userSubscriptions.stripeSubscriptionId} <> ${input.stripeSubscriptionId}`,
              lte(userSubscriptions.currentPeriodStart, inputStart),
            ),
          );
      }

      const [row] = await tx
        .insert(userSubscriptions)
        .values({
          userId: input.userId,
          stripeSubscriptionId: input.stripeSubscriptionId,
          stripeCustomerId: input.stripeCustomerId,
          plan: input.plan,
          status: input.status,
          creditsPerPeriod: Number(input.creditsPerPeriod),
          currentPeriodStart: new Date(input.currentPeriodStart),
          currentPeriodEnd: new Date(input.currentPeriodEnd),
          cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
        })
        .onConflictDoUpdate({
          target: userSubscriptions.stripeSubscriptionId,
          set: {
            status: input.status,
            creditsPerPeriod: Number(input.creditsPerPeriod),
            currentPeriodStart: new Date(input.currentPeriodStart),
            currentPeriodEnd: new Date(input.currentPeriodEnd),
            cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
            updatedAt: new Date(),
          },
          where: monotonicUpdateWhere(input),
        })
        .returning();

      if (!row) {
        const current = await this.getByStripeSubscriptionId(input.stripeSubscriptionId);
        if (current) return current;
        throw new Error("Failed to upsert subscription");
      }
      return toRecord(row);
    },

    async getByStripeSubscriptionId(stripeSubscriptionId) {
      const [row] = await activeDb(db)
        .select()
        .from(userSubscriptions)
        .where(eq(userSubscriptions.stripeSubscriptionId, stripeSubscriptionId))
        .limit(1);
      return row ? toRecord(row) : null;
    },
  };
}
