/**
 * Purpose: DB conformance tests for the production credit ledger's money
 * invariants: FIFO lot consumption, user-scoped balances, and replay-safe
 * model-call debit idempotency.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle credit ledger (postgres)", () => {
    it("requires DATABASE_URL", () => {});
  });
} else {
  describe("drizzle credit ledger (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const { creditLots, creditTransactions, users } = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { sql } = await import("drizzle-orm");
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleCreditLedger } = await import("../drizzle/credit-ledger.js");

    const db = createDb(DATABASE_URL, { max: 1 });
    const ledger = createDrizzleCreditLedger(db);

    const userId = "00000000-0000-4000-8000-000000000101";
    const projectId = "00000000-0000-4000-8000-000000000201";

    async function seedUser(): Promise<void> {
      await db.insert(users).values(conformanceUserValues(userId, "credit-ledger"));
    }

    beforeEach(async () => {
      await truncateDrizzleTables(db, [creditTransactions, creditLots, users]);
      await seedUser();
    });

    afterAll(async () => {
      await db.close();
    });

    it("consumes granted lots FIFO and makes remaining lot balance the canonical balance", async () => {
      await ledger.grant({
        userId,
        projectId,
        source: "manual",
        amountMillicredits: "100",
        reason: "older",
      });
      await ledger.grant({
        userId,
        projectId,
        source: "manual",
        amountMillicredits: "75",
        reason: "newer",
      });

      await ledger.debit({
        userId,
        projectId,
        rootThreadId: "root-thread",
        threadId: "thread-1",
        turnId: "turn-1",
        agentSlug: "agent",
        millicredits: "125",
        usageEventId: "model-response-1",
      });

      expect(await ledger.getBalance({ userId, projectId })).toBe("50");
      expect(
        await ledger.getRunDebitTotal({ userId, projectId, rootThreadId: "root-thread" }),
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
        projectId,
        source: "manual",
        amountMillicredits: "1000",
        reason: "pilot",
      });

      const input = {
        userId,
        projectId,
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
      expect(await ledger.getBalance({ userId, projectId })).toBe("875");
      expect(
        await ledger.getRunDebitTotal({ userId, projectId, rootThreadId: "root-thread" }),
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
        projectId,
        source: "stripe",
        amountMillicredits: "500",
        reason: null,
      });

      const lots = await db.select({ sourceType: creditLots.sourceType }).from(creditLots);
      expect(lots).toEqual([{ sourceType: "purchase" }]);
      expect(await ledger.getBalance({ userId, projectId })).toBe("500");
    });

    it("uses subscription grant_reason as the DB-enforced idempotency key", async () => {
      const input = {
        userId,
        projectId,
        source: "subscription" as const,
        amountMillicredits: "5000",
        reason: "subscription:sub_123:2026-06-01T00:00:00.000Z",
        expiresAt: "2026-07-01T00:00:00.000Z",
      };

      const first = await ledger.grant(input);
      const replay = await ledger.grant(input);

      expect(replay).toEqual({ transactionId: first.transactionId, created: false });
      expect(await ledger.getBalance({ userId, projectId })).toBe("5000");
      const lots = await db
        .select({ sourceType: creditLots.sourceType, reason: creditLots.grantReason })
        .from(creditLots);
      expect(lots).toEqual([
        {
          sourceType: "subscription",
          reason: "subscription:sub_123:2026-06-01T00:00:00.000Z",
        },
      ]);

      await expect(
        db.insert(creditLots).values({
          userId,
          sourceType: "subscription",
          originalAmountMillicredits: 5000,
          remainingMillicredits: 5000,
          grantReason: "subscription:sub_123:2026-06-01T00:00:00.000Z",
        }),
      ).rejects.toThrow();
    });

    it("creates signup and monthly manual grants once under concurrent grant calls", async () => {
      const signupInput = {
        userId,
        projectId,
        source: "manual" as const,
        amountMillicredits: "200000",
        reason: "signup",
      };
      const signupResults = await Promise.all(
        Array.from({ length: 8 }, () => ledger.grant(signupInput)),
      );
      const createdSignup = signupResults.filter((result) => result.created);
      expect(createdSignup).toHaveLength(1);
      expect(new Set(signupResults.map((result) => result.transactionId)).size).toBe(1);
      expect(await ledger.getBalance({ userId, projectId })).toBe("200000");

      const monthlyInput = {
        userId,
        projectId,
        source: "manual" as const,
        amountMillicredits: "200000",
        reason: "monthly_2026_07",
      };
      const monthlyResults = await Promise.all(
        Array.from({ length: 8 }, () => ledger.grant(monthlyInput)),
      );
      const createdMonthly = monthlyResults.filter((result) => result.created);
      expect(createdMonthly).toHaveLength(1);
      expect(new Set(monthlyResults.map((result) => result.transactionId)).size).toBe(1);
      expect(await ledger.getBalance({ userId, projectId })).toBe("400000");
    });
  });
}
