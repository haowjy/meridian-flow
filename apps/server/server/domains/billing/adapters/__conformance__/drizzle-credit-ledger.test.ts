// @ts-nocheck
/**
 * Purpose: DB conformance tests for the production credit ledger's money
 * invariants: FIFO lot consumption, user-scoped balances, and replay-safe
 * model-call debit idempotency.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  describe.skip("drizzle credit ledger (postgres)", () => {
    it("requires DATABASE_URL", () => {});
  });
} else {
  describe("drizzle credit ledger (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const { authUsers, creditLots, creditTransactions } = await import("@meridian/database/schema");
    const { sql } = await import("drizzle-orm");
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleCreditLedger } = await import("../drizzle/credit-ledger.js");

    const db = createDb(DATABASE_URL, { max: 1 });
    const ledger = createDrizzleCreditLedger(db);

    const userId = "00000000-0000-4000-8000-000000000101";
    const workbenchId = "00000000-0000-4000-8000-000000000201";

    async function seedUser(): Promise<void> {
      await db.insert(authUsers).values({ id: userId });
    }

    beforeEach(async () => {
      await truncateDrizzleTables(db, [creditTransactions, creditLots, authUsers]);
      await seedUser();
    });

    afterAll(async () => {
      await db.close();
    });

    it("consumes granted lots FIFO and makes remaining lot balance the canonical balance", async () => {
      await ledger.grant({
        userId,
        workbenchId,
        source: "manual",
        amountMillicredits: "100",
        reason: "older",
      });
      await ledger.grant({
        userId,
        workbenchId,
        source: "manual",
        amountMillicredits: "75",
        reason: "newer",
      });

      await ledger.debit({
        userId,
        workbenchId,
        rootThreadId: "root-thread",
        threadId: "thread-1",
        turnId: "turn-1",
        agentSlug: "agent",
        millicredits: "125",
        usageEventId: "model-response-1",
      });

      expect(await ledger.getBalance({ userId, workbenchId })).toBe("50");
      expect(
        await ledger.getRunDebitTotal({ userId, workbenchId, rootThreadId: "root-thread" }),
      ).toBe("125");

      const [lotTotal] = await db
        .select({ total: sql<bigint>`COALESCE(SUM(${creditLots.remainingMillicredits}), 0)` })
        .from(creditLots)
        .where(sql`${creditLots.userId} = ${userId}`);
      expect((lotTotal?.total ?? 0n).toString()).toBe("50");

      const debitRows = await db
        .select({ amount: creditTransactions.amountMillicredits, lotId: creditTransactions.lotId })
        .from(creditTransactions)
        .where(sql`${creditTransactions.transactionType} = 'consumption'`)
        .orderBy(creditTransactions.createdAt);
      expect(debitRows).toHaveLength(2);
      expect(debitRows.map((row) => row.amount.toString())).toEqual(["-100", "-25"]);
      expect(debitRows.every((row) => row.lotId)).toBe(true);
    });

    it("short-circuits replayed model-response persistence to one debit", async () => {
      await ledger.grant({
        userId,
        workbenchId,
        source: "manual",
        amountMillicredits: "1000",
        reason: "pilot",
      });

      const input = {
        userId,
        workbenchId,
        rootThreadId: "root-thread",
        threadId: "thread-1",
        turnId: "turn-1",
        agentSlug: "agent",
        millicredits: "125",
        usageEventId: "model-response-1",
      };
      const first = await ledger.debit(input);
      const replay = await ledger.debit(input);

      expect(replay.transactionId).toBe(first.transactionId);
      expect(await ledger.getBalance({ userId, workbenchId })).toBe("875");
      expect(
        await ledger.getRunDebitTotal({ userId, workbenchId, rootThreadId: "root-thread" }),
      ).toBe("125");

      const consumptionRows = await db
        .select()
        .from(creditTransactions)
        .where(sql`${creditTransactions.transactionType} = 'consumption'`);
      expect(consumptionRows).toHaveLength(1);
    });

    it("maps Stripe grants to purchase source_type accepted by the DB constraint", async () => {
      await ledger.grant({
        userId,
        workbenchId,
        source: "stripe",
        amountMillicredits: "500",
        reason: null,
      });

      const lots = await db.select({ sourceType: creditLots.sourceType }).from(creditLots);
      expect(lots).toEqual([{ sourceType: "purchase" }]);
      expect(await ledger.getBalance({ userId, workbenchId })).toBe("500");
    });
  });
}
