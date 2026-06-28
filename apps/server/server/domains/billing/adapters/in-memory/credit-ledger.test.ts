/** Tests the append-only in-memory credit ledger used by runtime integration tests. */
import { describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "./credit-ledger.js";

describe("in-memory credit ledger", () => {
  it("tags debits and derives user balance plus thread debit totals", async () => {
    const ledger = createInMemoryCreditLedger();
    await ledger.grant({
      userId: "user-1",
      source: "manual",
      amountMillicredits: "1000",
      reason: "pilot",
    });
    await ledger.debit({
      userId: "user-1",
      rootThreadId: "root-1",
      threadId: "thread-1",
      turnId: "turn-1",
      agentSlug: "worker",
      millicredits: "125",
      usageEventId: "usage-1",
    });

    expect(await ledger.getBalance({ userId: "user-1" })).toBe("875");
    expect(await ledger.getThreadDebitTotal({ userId: "user-1", threadId: "thread-1" })).toBe(
      "125",
    );
    await expect(ledger.getBalanceBreakdown({ userId: "user-1" })).resolves.toEqual({
      lots: [
        expect.objectContaining({
          source: "grant",
          balanceMillicredits: "875",
          originalMillicredits: "1000",
        }),
      ],
    });
  });

  it("short-circuits replayed model-call debits by user usage event", async () => {
    const ledger = createInMemoryCreditLedger();
    await ledger.grant({
      userId: "user-1",
      source: "manual",
      amountMillicredits: "1000",
      reason: "pilot",
    });

    const first = await ledger.debit({
      userId: "user-1",
      rootThreadId: "root-1",
      threadId: "thread-1",
      turnId: "turn-1",
      agentSlug: "worker",
      millicredits: "125",
      usageEventId: "model-response-1",
    });
    const replay = await ledger.debit({
      userId: "user-1",
      rootThreadId: "root-2",
      threadId: "thread-2",
      turnId: "turn-2",
      agentSlug: "worker",
      millicredits: "125",
      usageEventId: "model-response-1",
    });

    expect(replay.transactionId).toBe(first.transactionId);
    expect(await ledger.getBalance({ userId: "user-1" })).toBe("875");
    expect(await ledger.getThreadDebitTotal({ userId: "user-1", threadId: "thread-1" })).toBe(
      "125",
    );
  });

  it("does not share debit idempotency across users", async () => {
    const ledger = createInMemoryCreditLedger();
    await ledger.grant({ userId: "user-1", source: "manual", amountMillicredits: "1000" });
    await ledger.grant({ userId: "user-2", source: "manual", amountMillicredits: "1000" });

    const first = await ledger.debit({
      userId: "user-1",
      rootThreadId: "root-1",
      threadId: "thread-1",
      turnId: "turn-1",
      agentSlug: "worker",
      millicredits: "125",
      usageEventId: "model-response-1",
    });
    const second = await ledger.debit({
      userId: "user-2",
      rootThreadId: "root-1",
      threadId: "thread-1",
      turnId: "turn-1",
      agentSlug: "worker",
      millicredits: "125",
      usageEventId: "model-response-1",
    });

    expect(second.transactionId).not.toBe(first.transactionId);
    expect(await ledger.getBalance({ userId: "user-1" })).toBe("875");
    expect(await ledger.getBalance({ userId: "user-2" })).toBe("875");
  });

  it("short-circuits replayed subscription grants by user idempotency key", async () => {
    const ledger = createInMemoryCreditLedger();
    const input = {
      userId: "user-1",
      source: "subscription" as const,
      amountMillicredits: "5000",
      reason: "plan_standard",
      stripeIdempotencyId: "invoice_in_123_line_1",
      displayReason: "Monthly usage",
      expiresAt: "2099-07-01T00:00:00.000Z",
    };

    const first = await ledger.grant(input);
    const replay = await ledger.grant(input);

    expect(replay).toEqual({ transactionId: first.transactionId, created: false });
    expect(await ledger.getBalance({ userId: "user-1" })).toBe("5000");
    await expect(ledger.listTransactions({ userId: "user-1" })).resolves.toEqual([
      expect.objectContaining({ displayReason: "Monthly usage" }),
    ]);
    await expect(
      ledger.hasUnexpiredLot({ userId: "user-1", source: "subscription" }),
    ).resolves.toBe(true);
  });

  it("uses display reasons without treating them as grant idempotency", async () => {
    const ledger = createInMemoryCreditLedger();

    await ledger.grant({
      userId: "user-1",
      source: "manual",
      amountMillicredits: "100",
      displayReason: "Adjustment",
    });
    await ledger.grant({
      userId: "user-1",
      source: "manual",
      amountMillicredits: "200",
      displayReason: "Adjustment",
    });

    expect(await ledger.getBalance({ userId: "user-1" })).toBe("300");
    await expect(ledger.listTransactions({ userId: "user-1" })).resolves.toHaveLength(2);
  });

  it("shows friendly labels for purchase and subscription grants instead of machine ids", async () => {
    const ledger = createInMemoryCreditLedger();

    await ledger.grant({
      userId: "user-1",
      source: "stripe",
      amountMillicredits: "100",
      stripeIdempotencyId: "cs_machine_123",
      displayReason: "Extra usage",
    });
    await ledger.grant({
      userId: "user-1",
      source: "subscription",
      amountMillicredits: "200",
      stripeIdempotencyId: "il_machine_123",
      displayReason: "Monthly usage",
      expiresAt: "2099-07-01T00:00:00.000Z",
    });

    const transactions = await ledger.listTransactions({ userId: "user-1" });
    expect(transactions.map((tx) => tx.displayReason).sort()).toEqual([
      "Extra usage",
      "Monthly usage",
    ]);
    expect(transactions.map((tx) => tx.displayReason)).not.toContain("cs_machine_123");
    expect(transactions.map((tx) => tx.displayReason)).not.toContain("il_machine_123");
  });

  it("creates debt lots when a debit goes negative", async () => {
    const ledger = createInMemoryCreditLedger();
    await ledger.grant({ userId: "user-1", source: "manual", amountMillicredits: "100" });
    await ledger.debit({
      userId: "user-1",
      rootThreadId: "root-1",
      threadId: "thread-1",
      turnId: "turn-1",
      agentSlug: "worker",
      millicredits: "125",
      usageEventId: "usage-1",
    });

    expect(await ledger.getBalance({ userId: "user-1" })).toBe("-25");
    await expect(ledger.getBalanceBreakdown({ userId: "user-1" })).resolves.toEqual({
      lots: expect.arrayContaining([
        expect.objectContaining({ source: "grant", balanceMillicredits: "0" }),
        expect.objectContaining({ source: "debt", balanceMillicredits: "-25" }),
      ]),
    });
  });
});
