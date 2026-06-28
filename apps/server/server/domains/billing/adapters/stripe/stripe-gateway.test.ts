import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStripeBillingGateway, type StripeWebhookEvent } from "./stripe-gateway.js";

const stripeMock = vi.hoisted(() => ({
  checkoutSessionsCreate: vi.fn(),
  portalSessionsCreate: vi.fn(),
  subscriptionsList: vi.fn(),
  constructEvent: vi.fn(),
  customersCreate: vi.fn(),
}));

vi.mock("stripe", () => {
  class Stripe {
    checkout = { sessions: { create: stripeMock.checkoutSessionsCreate } };
    billingPortal = { sessions: { create: stripeMock.portalSessionsCreate } };
    subscriptions = { list: stripeMock.subscriptionsList };
    customers = { create: stripeMock.customersCreate };
    webhooks = { constructEvent: stripeMock.constructEvent };
  }
  return { default: Stripe };
});

function event(type: string, object: unknown): StripeWebhookEvent {
  return { type, data: { object } } as StripeWebhookEvent;
}

function checkoutSession(input: {
  id?: string;
  mode?: "payment" | "subscription";
  paymentStatus?: string;
  metadata?: Record<string, string>;
}) {
  return {
    id: input.id ?? "cs_test_123",
    mode: input.mode ?? "payment",
    payment_status: input.paymentStatus ?? "paid",
    metadata: input.metadata ?? { userId: "user_1", grantMillicredits: "500000", entryId: "extra" },
  };
}

describe("StripeBillingGateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates webhook construction to the Stripe SDK", () => {
    const expected = event("customer.created", { id: "cus_123" });
    stripeMock.constructEvent.mockReturnValue(expected);

    const gateway = createStripeBillingGateway({ secretKey: "sk_test", webhookSecret: "whsec" });

    expect(gateway.constructWebhookEvent({ rawBody: "raw", signature: "sig" })).toBe(expected);
    expect(stripeMock.constructEvent).toHaveBeenCalledWith("raw", "sig", "whsec");
  });

  it("creates Stripe customers with user metadata and deterministic idempotency", async () => {
    stripeMock.customersCreate.mockResolvedValue({ id: "cus_123" });
    const gateway = createStripeBillingGateway({ secretKey: "sk_test", webhookSecret: "whsec" });

    await expect(gateway.createCustomer({ userId: "user_1" })).resolves.toEqual({ id: "cus_123" });

    expect(stripeMock.customersCreate).toHaveBeenCalledWith(
      { metadata: { userId: "user_1" } },
      { idempotencyKey: "meridian_customer_user_1" },
    );
  });

  it("does not grant for unpaid checkout.session.completed", async () => {
    const gateway = createStripeBillingGateway({ secretKey: "sk_test", webhookSecret: "whsec" });

    await expect(
      gateway.resolveCheckoutGrant(
        event("checkout.session.completed", checkoutSession({ paymentStatus: "unpaid" })),
      ),
    ).resolves.toBeNull();
  });

  it("grants extra usage for checkout.session.async_payment_succeeded", async () => {
    const gateway = createStripeBillingGateway({ secretKey: "sk_test", webhookSecret: "whsec" });

    await expect(
      gateway.resolveCheckoutGrant(
        event(
          "checkout.session.async_payment_succeeded",
          checkoutSession({
            id: "cs_async",
            metadata: { userId: "user_1", grantMillicredits: "750000", entryId: "extra" },
          }),
        ),
      ),
    ).resolves.toEqual({
      userId: "user_1",
      amountMillicredits: "750000",
      source: "stripe",
      stripeIdempotencyId: "cs_async",
    });
  });

  it("grants extra usage for paid checkout.session.completed", async () => {
    const gateway = createStripeBillingGateway({ secretKey: "sk_test", webhookSecret: "whsec" });

    await expect(
      gateway.resolveCheckoutGrant(
        event(
          "checkout.session.completed",
          checkoutSession({
            id: "cs_paid",
            metadata: { userId: "user_2", grantMillicredits: "500000", entryId: "extra" },
          }),
        ),
      ),
    ).resolves.toEqual({
      userId: "user_2",
      amountMillicredits: "500000",
      source: "stripe",
      stripeIdempotencyId: "cs_paid",
    });
  });

  it("does not grant for subscription checkout.session.completed", async () => {
    const gateway = createStripeBillingGateway({ secretKey: "sk_test", webhookSecret: "whsec" });

    await expect(
      gateway.resolveCheckoutGrant(
        event("checkout.session.completed", checkoutSession({ mode: "subscription" })),
      ),
    ).resolves.toBeNull();
  });

  it("grants subscription credits from invoice.paid line period and subscription metadata", async () => {
    const gateway = createStripeBillingGateway({ secretKey: "sk_test", webhookSecret: "whsec" });

    await expect(
      gateway.resolveCheckoutGrant(
        event("invoice.paid", {
          id: "in_123",
          metadata: { userId: "ignored", grantMillicredits: "1", entryId: "invoice_fallback" },
          parent: {
            subscription_details: {
              subscription: "sub_123",
              metadata: {
                userId: "user_sub",
                grantMillicredits: "1000000",
                entryId: "plan_standard",
              },
            },
          },
          lines: {
            data: [
              {
                id: "il_proration",
                period: { start: 1_780_272_000, end: 1_782_864_000 },
                parent: {
                  subscription_item_details: { subscription: "sub_123", proration: true },
                },
              },
              {
                id: "il_period",
                period: { start: 1_782_864_000, end: 1_785_542_400 },
                parent: { subscription_item_details: { subscription: "sub_123" } },
              },
            ],
          },
        }),
      ),
    ).resolves.toEqual({
      userId: "user_sub",
      amountMillicredits: "1000000",
      source: "subscription",
      stripeIdempotencyId: "il_period",
      reason: "plan_standard",
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("ignores unrelated events", async () => {
    const gateway = createStripeBillingGateway({ secretKey: "sk_test", webhookSecret: "whsec" });

    await expect(
      gateway.resolveCheckoutGrant(event("customer.created", { id: "cus_123" })),
    ).resolves.toBeNull();
  });

  it("creates checkout with grantMillicredits metadata and subscription echo metadata", async () => {
    stripeMock.checkoutSessionsCreate.mockResolvedValue({
      id: "cs_plan",
      url: "https://stripe.test",
    });
    const gateway = createStripeBillingGateway({ secretKey: "sk_test", webhookSecret: "whsec" });

    await expect(
      gateway.createCheckoutSession({
        customerId: "cus_123",
        userId: "user_1",
        entry: {
          kind: "plan",
          grantMillicredits: "1000000",
          catalogId: "plan_standard",
          interval: "month",
        },
        stripePriceId: "price_123",
        successUrl: "https://app.test/success",
        cancelUrl: "https://app.test/cancel",
      }),
    ).resolves.toEqual({ id: "cs_plan", url: "https://stripe.test" });

    expect(stripeMock.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        customer: "cus_123",
        line_items: [{ price: "price_123", quantity: 1 }],
        metadata: {
          userId: "user_1",
          grantMillicredits: "1000000",
          entryId: "plan_standard",
        },
        subscription_data: {
          metadata: {
            userId: "user_1",
            grantMillicredits: "1000000",
            entryId: "plan_standard",
          },
        },
      }),
    );
  });
  it("creates extra-usage checkout as one-time payment without subscription data", async () => {
    stripeMock.checkoutSessionsCreate.mockResolvedValue({
      id: "cs_extra",
      url: "https://stripe.test/extra",
    });
    const gateway = createStripeBillingGateway({ secretKey: "sk_test", webhookSecret: "whsec" });

    await expect(
      gateway.createCheckoutSession({
        customerId: "cus_123",
        userId: "user_1",
        entry: {
          kind: "extra-usage",
          grantMillicredits: "1000000",
          catalogId: "extra_usage",
        },
        stripePriceId: null,
        successUrl: "https://app.test/success",
        cancelUrl: "https://app.test/cancel",
      }),
    ).resolves.toEqual({ id: "cs_extra", url: "https://stripe.test/extra" });

    expect(stripeMock.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: "Extra usage" },
              unit_amount: 1000,
            },
            quantity: 1,
          },
        ],
        subscription_data: undefined,
      }),
    );
  });
});
