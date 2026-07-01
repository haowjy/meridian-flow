import { describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../adapters/in-memory/credit-ledger.js";
import { FREE_TIER } from "./catalog.js";
import { ensureFreeTier } from "./free-grants.js";

const userId = "user-1";
const clock = { now: () => new Date("2026-06-12T00:00:00.000Z") };

describe("ensureFreeTier", () => {
  it("grants the monthly free tier when no subscription or free lot exists", async () => {
    const ledger = createInMemoryCreditLedger({ clock });

    await ensureFreeTier(ledger, userId, { clock });

    expect(await ledger.getBalance({ userId })).toBe(FREE_TIER.grantMillicredits);
    const transactions = await ledger.listTransactions({ userId });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      sourceType: "grant",
      displayReason: "Monthly usage",
      amountMillicredits: FREE_TIER.grantMillicredits,
    });
  });

  it("skips when an unexpired subscription lot exists", async () => {
    const ledger = createInMemoryCreditLedger({ clock });
    await ledger.grant({
      userId,
      source: "subscription",
      amountMillicredits: "1000000",
      stripeIdempotencyId: "invoice_1",
      expiresAt: "2099-07-01T00:00:00.000Z",
    });

    await ensureFreeTier(ledger, userId, { clock });

    expect(await ledger.getBalance({ userId })).toBe("1000000");
    await expect(ledger.listTransactions({ userId })).resolves.toHaveLength(1);
  });

  it("is idempotent under concurrent calls with the same deterministic key", async () => {
    const ledger = createInMemoryCreditLedger({ clock });

    await Promise.all(Array.from({ length: 8 }, () => ensureFreeTier(ledger, userId, { clock })));

    expect(await ledger.getBalance({ userId })).toBe(FREE_TIER.grantMillicredits);
    const transactions = await ledger.listTransactions({ userId });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.metadata.stripeIdempotencyId).toBe(`free_tier_${userId}_2026-06-01`);
    expect(transactions[0]?.metadata.reason).toBe("Monthly usage");
  });

  it("does not expose the free-tier machine key as the transaction reason", async () => {
    const ledger = createInMemoryCreditLedger({ clock });

    await ensureFreeTier(ledger, userId, { clock });

    const [transaction] = await ledger.listTransactions({ userId });
    expect(transaction?.displayReason).toBe("Monthly usage");
    expect(transaction?.displayReason).not.toBe(`free_tier_${userId}_2026-06-01`);
  });
});
