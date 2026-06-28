import { describe, expect, it, vi } from "vitest";
import type { StripeBillingGateway, StripeWebhookEvent } from "./adapters/stripe/stripe-gateway.js";
import { createInMemoryCreditLedger } from "./index.js";
import { type BillingServiceDeps, createBillingService } from "./service.js";

function createMockStripeBillingGateway(): StripeBillingGateway {
  return {
    createCustomer: vi.fn(async () => ({ id: "cus_123" })),
    createCheckoutSession: vi.fn(async () => ({
      id: "cs_123",
      url: "https://stripe.test/checkout",
    })),
    createPortalSession: vi.fn(async () => ({ url: "https://stripe.test/portal" })),
    getLiveSubscription: vi.fn(async () => null),
    constructWebhookEvent: vi.fn((input) => JSON.parse(input.rawBody) as StripeWebhookEvent),
  };
}

function deps(input: Partial<BillingServiceDeps> = {}): BillingServiceDeps {
  const ledger = input.ledger ?? createInMemoryCreditLedger();
  return {
    ledger,
    stripeGateway: Object.hasOwn(input, "stripeGateway")
      ? (input.stripeGateway ?? null)
      : createMockStripeBillingGateway(),
    getOrCreateStripeCustomer: input.getOrCreateStripeCustomer ?? vi.fn(async () => "cus_123"),
    env: input.env ?? {
      STRIPE_PRICE_PLAN_STANDARD: "price_standard",
      STRIPE_PRICE_PLAN_PREMIUM: "price_premium",
    },
  };
}

async function debit(ledger: ReturnType<typeof createInMemoryCreditLedger>, amount: string) {
  await ledger.debit({
    userId: "user-1",
    rootThreadId: "thread-1",
    threadId: "thread-1",
    turnId: "turn-1",
    agentSlug: "writer",
    millicredits: amount,
    usageEventId: `usage-${amount}-${crypto.randomUUID()}`,
  });
}

describe("billing service", () => {
  it("computes included usage percentage, usage mode, purchased USD, and canStartTurn", async () => {
    const ledger = createInMemoryCreditLedger();
    await ledger.grant({
      userId: "user-1",
      source: "subscription",
      amountMillicredits: "1000000",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: "plan_standard",
    });
    await ledger.grant({ userId: "user-1", source: "stripe", amountMillicredits: "735000" });
    await debit(ledger, "250000");

    await expect(
      createBillingService(deps({ ledger })).balance({ userId: "user-1" }),
    ).resolves.toEqual({
      purchasedBalanceUsd: "7.35",
      canStartTurn: true,
      includedUsage: { mode: "subscription", remainingPercent: 75, overBudget: false },
    });
  });

  it("adds free included usage alongside purchased-only balance", async () => {
    const ledger = createInMemoryCreditLedger();
    await ledger.grant({ userId: "user-1", source: "stripe", amountMillicredits: "500000" });

    await expect(
      createBillingService(deps({ ledger })).balance({ userId: "user-1" }),
    ).resolves.toEqual({
      purchasedBalanceUsd: "5",
      canStartTurn: true,
      includedUsage: { mode: "free", remainingPercent: 100, overBudget: false },
    });
  });

  it("blocks new turns at exactly zero balance", async () => {
    const ledger = createInMemoryCreditLedger();
    await ledger.grant({
      userId: "user-1",
      source: "subscription",
      amountMillicredits: "500000",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: "plan_standard",
    });
    await debit(ledger, "500000");

    await expect(
      createBillingService(deps({ ledger })).balance({ userId: "user-1" }),
    ).resolves.toMatchObject({
      canStartTurn: false,
    });
  });

  it("uses only free-tier grants as free included usage and can exceed 100% with debt", async () => {
    const ledger = createInMemoryCreditLedger();
    await ledger.grant({
      userId: "user-1",
      source: "free",
      amountMillicredits: "200000",
      reason: "free_tier_user-1_2026-06-01",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await debit(ledger, "250000");

    await expect(
      createBillingService(deps({ ledger })).balance({ userId: "user-1" }),
    ).resolves.toMatchObject({
      canStartTurn: false,
      includedUsage: { mode: "free", remainingPercent: 0, overBudget: true },
    });
  });

  it("does not let manual grants displace free included usage", async () => {
    const ledger = createInMemoryCreditLedger();
    await ledger.grant({
      userId: "user-1",
      source: "manual",
      amountMillicredits: "200000",
      reason: "support_adjustment",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    await expect(
      createBillingService(deps({ ledger })).balance({ userId: "user-1" }),
    ).resolves.toMatchObject({
      canStartTurn: true,
      includedUsage: { mode: "free", remainingPercent: 100, overBudget: false },
    });
  });

  it("ensures free tier on balance and transaction reads and maps transactions to USD", async () => {
    const ledger = createInMemoryCreditLedger();
    await ledger.grant({ userId: "user-1", source: "stripe", amountMillicredits: "500000" });
    await debit(ledger, "12345");

    const billingDeps = deps({ ledger });
    const txs = await createBillingService(billingDeps).transactions({ userId: "user-1" });

    expect(txs.usage).toEqual({ totalConsumedUsd: "0.12345", transactionCount: 3 });
    expect(txs.transactions.map((tx) => tx.amountUsd)).toContain("-0.12345");
    expect(txs.transactions.map((tx) => tx.label)).toContain("Monthly usage");
    await expect(
      createBillingService(billingDeps).balance({ userId: "user-1" }),
    ).resolves.toMatchObject({
      includedUsage: { mode: "free", remainingPercent: 100, overBudget: false },
    });
  });

  it("returns paid products only and reports Stripe configuration", () => {
    const configured = createBillingService(deps()).products();
    expect(configured.stripeConfigured).toBe(true);
    expect(configured.entries.map((entry) => entry.id)).toEqual([
      "plan_standard",
      "plan_premium",
      "extra_usage",
    ]);
    expect(configured.entries.find((entry) => entry.id === "plan_standard")).toEqual({
      id: "plan_standard",
      kind: "plan",
      name: "Standard",
      description: "Monthly usage for steady serial drafting.",
      priceUsd: "10.00",
      interval: "month",
    });
    expect(configured.entries.find((entry) => entry.id === "extra_usage")).toEqual({
      id: "extra_usage",
      kind: "extra-usage",
      name: "Extra usage",
      description: "Add standalone pay-as-you-go balance.",
      amountOptions: {
        minUsd: "5.00",
        maxUsd: "500.00",
        defaultUsd: "10.00",
        presetsUsd: ["5.00", "10.00", "25.00", "50.00"],
      },
    });
    expect(createBillingService(deps({ stripeGateway: null })).products().stripeConfigured).toBe(
      false,
    );

    expect(
      createBillingService(
        deps({
          env: { STRIPE_PRICE_PLAN_STANDARD: "price_standard" },
        }),
      ).products().stripeConfigured,
    ).toBe(false);
  });

  it("creates checkout sessions and sends active subscribers to the portal", async () => {
    const gateway = createMockStripeBillingGateway();
    const billingDeps = deps({ stripeGateway: gateway });

    await expect(
      createBillingService(billingDeps).createCheckoutSession({
        userId: "user-1",
        body: {
          entryId: "plan_standard",
          successUrl: "https://app.test/success",
          cancelUrl: "https://app.test/billing",
        },
      }),
    ).resolves.toEqual({
      kind: "checkout",
      sessionId: "cs_123",
      url: "https://stripe.test/checkout",
    });
    expect(gateway.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ stripePriceId: "price_standard" }),
    );

    vi.mocked(gateway.getLiveSubscription).mockResolvedValueOnce({ id: "sub_1", status: "active" });
    await expect(
      createBillingService(billingDeps).createCheckoutSession({
        userId: "user-1",
        body: {
          entryId: "plan_standard",
          successUrl: "https://app.test/success",
          cancelUrl: "https://app.test/billing",
        },
      }),
    ).resolves.toEqual({ kind: "portal", url: "https://stripe.test/portal" });
  });

  it("creates extra-usage checkout from arbitrary in-range amountUsd", async () => {
    const gateway = createMockStripeBillingGateway();
    const billingDeps = deps({ stripeGateway: gateway });

    await createBillingService(billingDeps).createCheckoutSession({
      userId: "user-1",
      body: {
        entryId: "extra_usage",
        amountUsd: "23.00",
        successUrl: "https://app.test/success",
        cancelUrl: "https://app.test/billing",
      },
    });
    expect(gateway.createCheckoutSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ kind: "extra-usage", grantMillicredits: "2300000" }),
        stripePriceId: null,
      }),
    );

    await createBillingService(billingDeps).createCheckoutSession({
      userId: "user-1",
      body: {
        entryId: "extra_usage",
        amountUsd: "7.50",
        successUrl: "https://app.test/success",
        cancelUrl: "https://app.test/billing",
      },
    });
    expect(gateway.createCheckoutSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ kind: "extra-usage", grantMillicredits: "750000" }),
        stripePriceId: null,
      }),
    );
  });

  it("rejects checkout without Stripe and unknown entries", async () => {
    await expect(
      createBillingService(deps({ stripeGateway: null })).createCheckoutSession({
        userId: "user-1",
        body: { entryId: "plan_standard", successUrl: "https://ok", cancelUrl: "https://ok" },
      }),
    ).rejects.toThrow("Stripe checkout is not configured");
    await expect(
      createBillingService(deps()).createCheckoutSession({
        userId: "user-1",
        body: { entryId: "plan_free", successUrl: "https://ok", cancelUrl: "https://ok" },
      }),
    ).rejects.toThrow("Unknown billing entry");
  });

  it("rejects invalid extra-usage amountUsd at the route core", async () => {
    await expect(
      createBillingService(deps()).createCheckoutSession({
        userId: "user-1",
        body: { entryId: "extra_usage", successUrl: "https://ok", cancelUrl: "https://ok" },
      }),
    ).rejects.toThrow("amountUsd is required");

    const invalidAmounts = [
      ["4.99", "amountUsd must be at least 5.00"],
      ["0", "amountUsd must be positive"],
      ["abc", "amountUsd must be a positive USD decimal with at most 2 decimal places"],
      ["600.00", "amountUsd must be at most 500.00"],
    ] as const;

    for (const [amountUsd, message] of invalidAmounts) {
      await expect(
        createBillingService(deps()).createCheckoutSession({
          userId: "user-1",
          body: {
            entryId: "extra_usage",
            amountUsd,
            successUrl: "https://ok",
            cancelUrl: "https://ok",
          },
        }),
      ).rejects.toThrow(message);
    }
  });

  it("handles webhook grants idempotently through the ledger", async () => {
    const ledger = createInMemoryCreditLedger();
    const billingDeps = deps({ ledger });
    const payload = JSON.stringify({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          mode: "payment",
          payment_status: "paid",
          metadata: { userId: "user-1", grantMillicredits: "500000" },
        },
      },
    });

    await expect(
      createBillingService(billingDeps).handleWebhook({ payload, signature: "sig" }),
    ).resolves.toEqual({
      received: true,
    });
    await createBillingService(billingDeps).handleWebhook({ payload, signature: "sig" });
    expect(await ledger.getBalance({ userId: "user-1" })).toBe("500000");
  });
});
