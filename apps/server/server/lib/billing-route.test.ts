import { describe, expect, it, vi } from "vitest";
import type {
  StripeBillingGateway,
  StripeWebhookEvent,
} from "../domains/billing/adapters/stripe/stripe-gateway.js";
import { createInMemoryCreditLedger } from "../domains/billing/index.js";
import {
  type BillingRouteDeps,
  billingBalance,
  billingProducts,
  billingTransactions,
  createBillingCheckoutSession,
  handleBillingWebhook,
} from "./billing-route.js";

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
    resolveCheckoutGrant: vi.fn(async (event: StripeWebhookEvent) => {
      const object = event.data.object as {
        userId?: string;
        amountMillicredits?: string;
        id?: string;
      };
      if (!object.userId || !object.amountMillicredits) return null;
      return {
        userId: object.userId,
        amountMillicredits: object.amountMillicredits,
        source: "stripe" as const,
        stripeIdempotencyId: object.id ?? "evt_1",
      };
    }),
  };
}

function deps(input: Partial<BillingRouteDeps> = {}): BillingRouteDeps {
  const ledger = input.ledger ?? createInMemoryCreditLedger();
  return {
    ledger,
    stripeGateway: Object.hasOwn(input, "stripeGateway")
      ? (input.stripeGateway ?? null)
      : createMockStripeBillingGateway(),
    freeTier: input.freeTier ?? { ensure: vi.fn(async () => {}) },
    getOrCreateStripeCustomer: input.getOrCreateStripeCustomer ?? vi.fn(async () => "cus_123"),
    env: {
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

describe("billing-route", () => {
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

    await expect(billingBalance(deps({ ledger }), { userId: "user-1" })).resolves.toEqual({
      purchasedBalanceUsd: "7.35",
      includedUsagePercent: 25,
      usageMode: "subscription",
      canStartTurn: true,
    });
  });

  it("uses free grants as included usage when no subscription exists and can exceed 100%", async () => {
    const ledger = {
      ...createInMemoryCreditLedger(),
      async getBalanceBreakdown() {
        return {
          lots: [
            {
              source: "grant" as const,
              balanceMillicredits: "-50000",
              originalMillicredits: "200000",
              expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            },
          ],
        };
      },
    };

    await expect(billingBalance(deps({ ledger }), { userId: "user-1" })).resolves.toMatchObject({
      includedUsagePercent: 125,
      usageMode: "free",
      canStartTurn: false,
    });
  });

  it("ensures free tier on balance and transaction reads and maps transactions to USD", async () => {
    const ledger = createInMemoryCreditLedger();
    const ensure = vi.fn(async () => {});
    await ledger.grant({ userId: "user-1", source: "stripe", amountMillicredits: "500000" });
    await debit(ledger, "12345");

    const routeDeps = deps({ ledger, freeTier: { ensure } });
    const txs = await billingTransactions(routeDeps, { userId: "user-1" });

    expect(ensure).toHaveBeenCalledWith("user-1");
    expect(txs.usage).toEqual({ totalConsumedUsd: "0.12345", transactionCount: 2 });
    expect(txs.transactions.map((tx) => tx.amountUsd)).toContain("-0.12345");
    await billingBalance(routeDeps, { userId: "user-1" });
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it("returns paid products only and reports Stripe configuration", () => {
    const configured = billingProducts(deps());
    expect(configured.stripeConfigured).toBe(true);
    expect(configured.entries.map((entry) => entry.id)).toEqual([
      "plan_standard",
      "plan_premium",
      "extra_usage",
    ]);
    expect(billingProducts(deps({ stripeGateway: null })).stripeConfigured).toBe(false);
  });

  it("creates checkout sessions and sends active subscribers to the portal", async () => {
    const gateway = createMockStripeBillingGateway();
    const routeDeps = deps({ stripeGateway: gateway });

    await expect(
      createBillingCheckoutSession(routeDeps, {
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
      createBillingCheckoutSession(routeDeps, {
        userId: "user-1",
        body: {
          entryId: "plan_standard",
          successUrl: "https://app.test/success",
          cancelUrl: "https://app.test/billing",
        },
      }),
    ).resolves.toEqual({ kind: "portal", url: "https://stripe.test/portal" });
  });

  it("creates extra-usage checkout from amountUsd increments", async () => {
    const gateway = createMockStripeBillingGateway();
    await createBillingCheckoutSession(deps({ stripeGateway: gateway }), {
      userId: "user-1",
      body: {
        entryId: "extra_usage",
        amountUsd: "10.00",
        successUrl: "https://app.test/success",
        cancelUrl: "https://app.test/billing",
      },
    });
    expect(gateway.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ kind: "extra-usage", grantMillicredits: "1000000" }),
        stripePriceId: null,
      }),
    );
  });

  it("rejects checkout without Stripe and for the free tier", async () => {
    await expect(
      createBillingCheckoutSession(deps({ stripeGateway: null }), {
        userId: "user-1",
        body: { entryId: "plan_standard", successUrl: "https://ok", cancelUrl: "https://ok" },
      }),
    ).rejects.toThrow("Stripe checkout is not configured");
    await expect(
      createBillingCheckoutSession(deps(), {
        userId: "user-1",
        body: { entryId: "plan_free", successUrl: "https://ok", cancelUrl: "https://ok" },
      }),
    ).rejects.toThrow("Free tier");
  });

  it("handles webhook grants idempotently through the ledger", async () => {
    const ledger = createInMemoryCreditLedger();
    const routeDeps = deps({ ledger });
    const payload = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", userId: "user-1", amountMillicredits: "500000" } },
    });

    await expect(handleBillingWebhook(routeDeps, { payload, signature: "sig" })).resolves.toEqual({
      received: true,
    });
    await handleBillingWebhook(routeDeps, { payload, signature: "sig" });
    expect(await ledger.getBalance({ userId: "user-1" })).toBe("500000");
  });
});
