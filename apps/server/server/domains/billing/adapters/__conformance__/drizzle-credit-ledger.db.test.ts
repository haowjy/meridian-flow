/**
 * Purpose: DB conformance tests for the production credit ledger's money
 * invariants: FIFO lot consumption, user-scoped balances, and replay-safe
 * model-call debit idempotency.
 */
import { beforeEach, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle credit ledger (postgres)", () => {
    it("requires DATABASE_URL", () => {});
  });
} else {
  describe("drizzle credit ledger (postgres)", async () => {
    const { creditLots, creditTransactions, users } = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { sql } = await import("drizzle-orm");
    const { useRollbackTestDatabase } = await import(
      "../../../../test-support/rollback-test-database.js"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleCreditLedger } = await import("../drizzle/credit-ledger.js");
    const { ensureFreeTier } = await import("../../domain/free-grants.js");

    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 8,
      prepareSuite: (db) => truncateDrizzleTables(db, [users]),
    });
    let db = database.current;
    let ledger = createDrizzleCreditLedger(db);

    const userId = "00000000-0000-4000-8000-000000000101";
    async function seedUser(): Promise<void> {
      await db.insert(users).values(conformanceUserValues(userId, "credit-ledger"));
    }

    beforeEach(async () => {
      db = database.current;
      ledger = createDrizzleCreditLedger(db);
      await seedUser();
    });

    it("consumes granted lots FIFO and makes remaining lot balance the canonical balance", async () => {
      await ledger.grant({
        userId,
        source: "manual",
        amountMillicredits: "100",
        reason: "older",
      });
      await ledger.grant({
        userId,
        source: "manual",
        amountMillicredits: "75",
        reason: "newer",
      });
      await db
        .update(creditLots)
        .set({ createdAt: new Date("2025-01-01T00:00:00.000Z") })
        .where(sql`${creditLots.grantReason} = 'older'`);
      await db
        .update(creditLots)
        .set({ createdAt: new Date("2025-01-02T00:00:00.000Z") })
        .where(sql`${creditLots.grantReason} = 'newer'`);

      await ledger.debit({
        userId,
        rootThreadId: "root-thread",
        threadId: "thread-1",
        turnId: "turn-1",
        agentSlug: "agent",
        millicredits: "125",
        usageEventId: "model-response-1",
      });

      expect(await ledger.getBalance({ userId })).toBe("50");
      const [lotTotal] = await db
        .select({ total: sql<bigint>`COALESCE(SUM(${creditLots.remainingMillicredits}), 0)` })
        .from(creditLots)
        .where(sql`${creditLots.userId} = ${userId}`);
      expect((lotTotal?.total ?? 0n).toString()).toBe("50");

      const debitRows = await db
        .select({
          amount: creditTransactions.amountMillicredits,
          lotId: creditTransactions.lotId,
          lotReason: creditLots.grantReason,
        })
        .from(creditTransactions)
        .leftJoin(creditLots, sql`${creditTransactions.lotId} = ${creditLots.id}`)
        .where(sql`${creditTransactions.transactionType} = 'consumption'`)
        .orderBy(creditLots.createdAt);
      expect(debitRows).toHaveLength(2);
      expect(debitRows.map((row) => row.amount.toString())).toEqual(["-100", "-25"]);
      expect(debitRows.map((row) => row.lotReason)).toEqual(["older", "newer"]);
      expect(debitRows.every((row) => row.lotId)).toBe(true);
    });

    it("short-circuits replayed model-response persistence to one debit", async () => {
      await ledger.grant({
        userId,
        source: "manual",
        amountMillicredits: "1000",
        reason: "pilot",
      });

      const input = {
        userId,
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
      expect(await ledger.getBalance({ userId })).toBe("875");
      const consumptionRows = await db
        .select()
        .from(creditTransactions)
        .where(sql`${creditTransactions.transactionType} = 'consumption'`);
      expect(consumptionRows).toHaveLength(1);
    });

    it("scopes replay idempotency per user (same usageEventId debits each user)", async () => {
      const otherUserId = "00000000-0000-4000-8000-000000000102";
      await db.insert(users).values(conformanceUserValues(otherUserId, "credit-ledger-2"));
      for (const id of [userId, otherUserId]) {
        await ledger.grant({
          userId: id,
          source: "manual",
          amountMillicredits: "1000",
          reason: "seed",
        });
      }

      const sharedEvent = "model-response-shared";
      const debitFor = (id: string) =>
        ledger.debit({
          userId: id,
          rootThreadId: "root-thread",
          threadId: "thread-1",
          turnId: "turn-1",
          agentSlug: "agent",
          millicredits: "125",
          usageEventId: sharedEvent,
        });

      const first = await debitFor(userId);
      const other = await debitFor(otherUserId);

      // Different users sharing a usageEventId must both be charged, with distinct
      // consumption groups — idempotency is (user_id, usage_event_id), not global.
      expect(other.transactionId).not.toBe(first.transactionId);
      expect(await ledger.getBalance({ userId })).toBe("875");
      expect(await ledger.getBalance({ userId: otherUserId })).toBe("875");

      // ...and replay within a single user is still short-circuited.
      const replay = await debitFor(userId);
      expect(replay.transactionId).toBe(first.transactionId);
      expect(await ledger.getBalance({ userId })).toBe("875");
    });

    it("maps Stripe grants to purchase source_type and friendly display text", async () => {
      await ledger.grant({
        userId,
        source: "stripe",
        amountMillicredits: "500",
        stripeIdempotencyId: "cs_machine_123",
        displayReason: "Extra usage",
      });

      const lots = await db.select({ sourceType: creditLots.sourceType }).from(creditLots);
      expect(lots).toEqual([{ sourceType: "purchase" }]);
      expect(await ledger.getBalance({ userId })).toBe("500");
      await expect(ledger.listTransactions({ userId })).resolves.toEqual([
        expect.objectContaining({ displayReason: "Extra usage" }),
      ]);
    });

    it("uses subscription grant_reason as the DB-enforced idempotency key", async () => {
      const input = {
        userId,
        source: "subscription" as const,
        amountMillicredits: "5000",
        reason: "invoice paid",
        stripeIdempotencyId: "subscription:sub_123:2026-06-01T00:00:00.000Z",
        expiresAt: "2099-07-01T00:00:00.000Z",
      };

      const first = await ledger.grant(input);
      const replay = await ledger.grant(input);

      expect(replay).toEqual({ transactionId: first.transactionId, created: false });
      expect(await ledger.getBalance({ userId })).toBe("5000");
      const lots = await db
        .select({ sourceType: creditLots.sourceType, reason: creditLots.grantReason })
        .from(creditLots);
      expect(lots).toEqual([
        {
          sourceType: "subscription",
          reason: "subscription:sub_123:2026-06-01T00:00:00.000Z",
        },
      ]);

      await expect(ledger.listTransactions({ userId })).resolves.toEqual([
        expect.objectContaining({ displayReason: "Monthly usage" }),
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

    it("creates one free-tier lot and transaction under concurrent ensureFreeTier calls", async () => {
      const now = new Date("2026-06-15T12:00:00.000Z");

      await Promise.all(
        Array.from({ length: 8 }, () =>
          ensureFreeTier(ledger, userId, { clock: { now: () => now } }),
        ),
      );

      const lots = await db
        .select({
          id: creditLots.id,
          sourceType: creditLots.sourceType,
          reason: creditLots.grantReason,
          remaining: creditLots.remainingMillicredits,
        })
        .from(creditLots)
        .where(sql`${creditLots.grantReason} LIKE 'free_tier_%'`);
      expect(lots).toEqual([
        {
          id: expect.any(String),
          sourceType: "grant",
          reason: `free_tier_${userId}_2026-06-01`,
          remaining: 200000,
        },
      ]);

      const transactions = await db
        .select({ id: creditTransactions.id, amount: creditTransactions.amountMillicredits })
        .from(creditTransactions)
        .where(sql`${creditTransactions.transactionType} = 'grant'`);
      expect(transactions).toEqual([{ id: expect.any(String), amount: 200000 }]);
      await expect(ledger.listTransactions({ userId })).resolves.toEqual([
        expect.objectContaining({ displayReason: "Monthly usage" }),
      ]);
    });
  });
}
