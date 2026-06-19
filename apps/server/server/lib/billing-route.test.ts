import { describe, expect, it } from "vitest";
import { createFakePaymentProvider } from "../domains/billing/adapters/fake/payment-provider.js";
import { createInMemoryCreditLedger } from "../domains/billing/adapters/in-memory/credit-ledger.js";
import { createInMemorySubscriptionStore } from "../domains/billing/adapters/in-memory/subscription-store.js";
import {
  billingBalance,
  billingPacksPlans,
  createBillingCheckoutSession,
  handleBillingWebhook,
} from "./billing-route.js";

const userId = "user-1";
const projectId = "project-1";

function deps(env: NodeJS.ProcessEnv = {}) {
  return {
    ledger: createInMemoryCreditLedger(),
    subscriptionStore: createInMemorySubscriptionStore(),
    paymentProvider: createFakePaymentProvider(),
    env,
  };
}

function stripeEnv(): NodeJS.ProcessEnv {
  return {
    STRIPE_SECRET_KEY: "sk_test_fake",
    STRIPE_WEBHOOK_SECRET: "whsec_fake",
  };
}

describe("billing route core", () => {
  it("returns fake provider status and needs-credentials catalog entry", () => {
    const response = billingPacksPlans(deps());
    expect(response.provider).toMatchObject({ mode: "fake", needsCredentials: true });
    expect(response.entries[0]?.id).toBe("needs_stripe_credentials");
  });

  it("fake checkout grants credits visible to the real project-scoped balance", async () => {
    const routeDeps = deps();
    const checkout = await createBillingCheckoutSession(routeDeps, {
      userId,
      projectId,
      body: {
        entryId: "pack_starter",
        successUrl: "https://app.localhost/billing",
        cancelUrl: "https://app.localhost/billing",
      },
    });

    expect(checkout.mode).toBe("fake");
    expect(checkout.needsCredentials).toBe(true);
    expect(checkout.url).toContain("checkout=fake");
    await expect(billingBalance(routeDeps, { userId, projectId })).resolves.toMatchObject({
      purchasedBalanceMillicredits: "1000000",
    });
    await expect(
      billingBalance(routeDeps, { userId, projectId: "other-project" }),
    ).resolves.toMatchObject({
      purchasedBalanceMillicredits: "0",
    });
  });

  it("rejects public webhooks when Stripe is not configured", async () => {
    await expect(
      handleBillingWebhook(deps(), {
        payload: JSON.stringify({ userId, entryId: "pack_starter", millicredits: "999999999" }),
        signature: null,
      }),
    ).rejects.toThrow(/Stripe webhook is disabled/);
  });

  it("ignores forged millicredits and grants catalog amount for pack webhooks", async () => {
    const routeDeps = deps(stripeEnv());
    const payload = JSON.stringify({
      id: "fake_cs_pack",
      userId,
      projectId,
      entryId: "pack_starter",
      millicredits: "999999999",
    });

    await handleBillingWebhook(routeDeps, { payload, signature: null });
    await expect(billingBalance(routeDeps, { userId, projectId })).resolves.toMatchObject({
      purchasedBalanceMillicredits: "1000000",
    });
  });

  it("plan checkout persists subscription state and grants the first period once", async () => {
    const routeDeps = deps(stripeEnv());
    const payload = JSON.stringify({
      id: "fake_cs_plan",
      userId,
      projectId,
      entryId: "plan_pro",
      millicredits: "999999999",
      customerId: "cus_123",
      subscriptionId: "sub_123",
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
    });

    const response = await handleBillingWebhook(routeDeps, { payload, signature: null });
    const replay = await handleBillingWebhook(routeDeps, { payload, signature: null });

    expect(response).toEqual({ received: true, action: "granted" });
    expect(replay).toEqual({ received: true, action: "granted" });
    const subscription = await routeDeps.subscriptionStore.getByStripeSubscriptionId("sub_123");
    expect(subscription).toMatchObject({
      userId,
      status: "active",
      creditsPerPeriod: "5000000",
    });
    const transactions = await routeDeps.ledger.listTransactions({ userId, projectId });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      sourceType: "subscription",
      reason: "subscription:sub_123:2026-06-01T00:00:00.000Z",
      amountMillicredits: "5000000",
    });
    await expect(billingBalance(routeDeps, { userId, projectId })).resolves.toMatchObject({
      subscriptionBalanceMillicredits: "5000000",
    });
  });

  it("renewal invoice grants each subscription period once", async () => {
    const routeDeps = deps(stripeEnv());
    const firstPeriod = JSON.stringify({
      type: "checkout.session.completed",
      data: {
        id: "fake_cs_plan",
        userId,
        projectId,
        entryId: "plan_pro",
        customerId: "cus_123",
        subscriptionId: "sub_123",
        periodStart: "2026-06-01T00:00:00.000Z",
        periodEnd: "2026-07-01T00:00:00.000Z",
      },
    });
    await handleBillingWebhook(routeDeps, { payload: firstPeriod, signature: null });

    const renewal = JSON.stringify({
      type: "invoice.paid",
      data: {
        id: "in_456",
        userId,
        projectId,
        entryId: "plan_pro",
        customerId: "cus_123",
        subscriptionId: "sub_123",
        periodStart: "2026-07-01T00:00:00.000Z",
        periodEnd: "2026-08-01T00:00:00.000Z",
      },
    });
    await handleBillingWebhook(routeDeps, { payload: renewal, signature: null });
    const replay = await handleBillingWebhook(routeDeps, { payload: renewal, signature: null });

    expect(replay).toEqual({ received: true, action: "granted" });
    const transactions = await routeDeps.ledger.listTransactions({ userId, projectId });
    expect(transactions).toHaveLength(2);
    expect(transactions.map((tx) => tx.reason).sort()).toEqual([
      "subscription:sub_123:2026-06-01T00:00:00.000Z",
      "subscription:sub_123:2026-07-01T00:00:00.000Z",
    ]);
    await expect(billingBalance(routeDeps, { userId, projectId })).resolves.toMatchObject({
      subscriptionBalanceMillicredits: "10000000",
    });
  });

  it("does not regress subscription state for stale lifecycle replays", async () => {
    const routeDeps = deps(stripeEnv());
    await handleBillingWebhook(routeDeps, {
      payload: JSON.stringify({
        type: "customer.subscription.updated",
        data: {
          userId,
          projectId,
          entryId: "plan_pro",
          customerId: "cus_123",
          subscriptionId: "sub_123",
          status: "active",
          periodStart: "2026-08-01T00:00:00.000Z",
          periodEnd: "2026-09-01T00:00:00.000Z",
        },
      }),
      signature: null,
    });
    await handleBillingWebhook(routeDeps, {
      payload: JSON.stringify({
        type: "customer.subscription.deleted",
        data: {
          userId,
          projectId,
          entryId: "plan_pro",
          customerId: "cus_123",
          subscriptionId: "sub_123",
          periodStart: "2026-08-01T00:00:00.000Z",
          periodEnd: "2026-09-01T00:00:00.000Z",
        },
      }),
      signature: null,
    });
    await handleBillingWebhook(routeDeps, {
      payload: JSON.stringify({
        type: "customer.subscription.updated",
        data: {
          userId,
          projectId,
          entryId: "plan_pro",
          customerId: "cus_123",
          subscriptionId: "sub_123",
          status: "active",
          periodStart: "2026-07-01T00:00:00.000Z",
          periodEnd: "2026-08-01T00:00:00.000Z",
        },
      }),
      signature: null,
    });
    await handleBillingWebhook(routeDeps, {
      payload: JSON.stringify({
        type: "checkout.session.completed",
        data: {
          id: "late_checkout",
          userId,
          projectId,
          entryId: "plan_pro",
          customerId: "cus_123",
          subscriptionId: "sub_123",
          periodStart: "2026-08-01T00:00:00.000Z",
          periodEnd: "2026-09-01T00:00:00.000Z",
        },
      }),
      signature: null,
    });

    await expect(
      routeDeps.subscriptionStore.getByStripeSubscriptionId("sub_123"),
    ).resolves.toMatchObject({
      status: "cancelled",
      currentPeriodStart: "2026-08-01T00:00:00.000Z",
    });
  });

  it("does not let a stale older subscription replace a newer active subscription", async () => {
    const routeDeps = deps(stripeEnv());
    await handleBillingWebhook(routeDeps, {
      payload: JSON.stringify({
        type: "customer.subscription.updated",
        data: {
          userId,
          projectId,
          entryId: "plan_pro",
          customerId: "cus_new",
          subscriptionId: "sub_new",
          status: "active",
          periodStart: "2026-08-01T00:00:00.000Z",
          periodEnd: "2026-09-01T00:00:00.000Z",
        },
      }),
      signature: null,
    });
    await handleBillingWebhook(routeDeps, {
      payload: JSON.stringify({
        type: "customer.subscription.updated",
        data: {
          userId,
          projectId,
          entryId: "plan_pro",
          customerId: "cus_old",
          subscriptionId: "sub_old",
          status: "active",
          periodStart: "2026-07-01T00:00:00.000Z",
          periodEnd: "2026-08-01T00:00:00.000Z",
        },
      }),
      signature: null,
    });

    await expect(
      routeDeps.subscriptionStore.getByStripeSubscriptionId("sub_new"),
    ).resolves.toMatchObject({
      status: "active",
      currentPeriodStart: "2026-08-01T00:00:00.000Z",
    });
    await expect(
      routeDeps.subscriptionStore.getByStripeSubscriptionId("sub_old"),
    ).resolves.toBeNull();
  });
});
