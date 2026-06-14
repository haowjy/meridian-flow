/** Tests the append-only in-memory credit ledger used by runtime integration tests. */
import { describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "./credit-ledger.js";

describe("in-memory credit ledger", () => {
  it("tags debits and derives balances and rollups by SUM", async () => {
    const ledger = createInMemoryCreditLedger();
    await ledger.grant({
      userId: "user-1",
      projectId: "wb-1",
      source: "manual",
      amountMillicredits: "1000",
      reason: "pilot",
    });
    await ledger.debit({
      userId: "user-1",
      projectId: "wb-1",
      rootThreadId: "root-1",
      threadId: "thread-1",
      turnId: "turn-1",
      agentSlug: "worker",
      millicredits: "125",
      usageEventId: "usage-1",
    });

    expect(await ledger.getBalance({ userId: "user-1", projectId: "wb-1" })).toBe("875");
    expect(
      await ledger.getRunDebitTotal({
        userId: "user-1",
        projectId: "wb-1",
        rootThreadId: "root-1",
      }),
    ).toBe("125");
    expect(
      await ledger.getAgentDebitTotals({
        userId: "user-1",
        projectId: "wb-1",
        rootThreadId: "root-1",
      }),
    ).toEqual([{ agentSlug: "worker", millicredits: "125" }]);
  });

  it("short-circuits replayed model-call debits by project usage event", async () => {
    const ledger = createInMemoryCreditLedger();
    await ledger.grant({
      userId: "user-1",
      projectId: "wb-1",
      source: "manual",
      amountMillicredits: "1000",
      reason: "pilot",
    });

    const first = await ledger.debit({
      userId: "user-1",
      projectId: "wb-1",
      rootThreadId: "root-1",
      threadId: "thread-1",
      turnId: "turn-1",
      agentSlug: "worker",
      millicredits: "125",
      usageEventId: "model-response-1",
    });
    const replay = await ledger.debit({
      userId: "user-1",
      projectId: "wb-1",
      rootThreadId: "root-1",
      threadId: "thread-1",
      turnId: "turn-1",
      agentSlug: "worker",
      millicredits: "125",
      usageEventId: "model-response-1",
    });

    expect(replay.transactionId).toBe(first.transactionId);
    expect(await ledger.getBalance({ userId: "user-1", projectId: "wb-1" })).toBe("875");
    expect(
      await ledger.getRunDebitTotal({
        userId: "user-1",
        projectId: "wb-1",
        rootThreadId: "root-1",
      }),
    ).toBe("125");
  });

  it("short-circuits replayed subscription grants by user-credit reason", async () => {
    const ledger = createInMemoryCreditLedger();
    const input = {
      userId: "user-1",
      projectId: "wb-1",
      source: "subscription" as const,
      amountMillicredits: "5000",
      reason: "subscription:sub_123:2026-06-01T00:00:00.000Z",
      expiresAt: "2026-07-01T00:00:00.000Z",
    };

    const first = await ledger.grant(input);
    const replay = await ledger.grant(input);

    expect(replay).toEqual({ transactionId: first.transactionId, created: false });
    expect(await ledger.getBalance({ userId: "user-1", projectId: "wb-1" })).toBe("5000");
    await expect(
      ledger.listTransactions({ userId: "user-1", projectId: "wb-1" }),
    ).resolves.toHaveLength(1);
  });

  it("allows canStartTurn at exact zero balance", async () => {
    const ledger = createInMemoryCreditLedger();
    await ledger.grant({
      userId: "user-1",
      projectId: "wb-1",
      source: "manual",
      amountMillicredits: "100",
      reason: "pilot",
    });
    await ledger.debit({
      userId: "user-1",
      projectId: "wb-1",
      rootThreadId: "root-1",
      threadId: "thread-1",
      turnId: "turn-1",
      agentSlug: "worker",
      millicredits: "100",
      usageEventId: "usage-1",
    });

    await expect(
      ledger.getBalanceBreakdown({ userId: "user-1", projectId: "wb-1" }),
    ).resolves.toMatchObject({
      totalBalanceMillicredits: "0",
      canStartTurn: true,
    });
  });
});
