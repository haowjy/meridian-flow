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
