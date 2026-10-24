/** Consolidated test contracts; each block retains its original fixture scope. */

import { describe as __mergedSuite, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../adapters/in-memory/credit-ledger.js";
import { FREE_TIER } from "./catalog.js";
import { ensureFreeTier } from "./free-grants.js";
import { resolveStripeWebhookGrant, type StripeWebhookEventLike } from "./stripe-webhook-grants.js";

__mergedSuite("stripe-webhook-grants.test.ts", () => {
  // Merged from apps/server/server/domains/billing/domain/stripe-webhook-grants.test.ts.
  function event(type: string, object: unknown): StripeWebhookEventLike {
    return { type, data: { object } };
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
      metadata: input.metadata ?? {
        userId: "user_1",
        grantMillicredits: "500000",
        entryId: "extra",
      },
    };
  }

  __mergedSuite("resolveStripeWebhookGrant", () => {
    it("does not grant for unpaid checkout.session.completed", () => {
      expect(
        resolveStripeWebhookGrant(
          event("checkout.session.completed", checkoutSession({ paymentStatus: "unpaid" })),
        ),
      ).toBeNull();
    });
    it("grants extra usage for checkout.session.async_payment_succeeded", () => {
      expect(
        resolveStripeWebhookGrant(
          event(
            "checkout.session.async_payment_succeeded",
            checkoutSession({
              id: "cs_async",
              metadata: { userId: "user_1", grantMillicredits: "750000", entryId: "extra" },
            }),
          ),
        ),
      ).toEqual({
        userId: "user_1",
        amountMillicredits: "750000",
        source: "stripe",
        stripeIdempotencyId: "cs_async",
        displayReason: "Extra usage",
      });
    });
    it("grants extra usage for paid checkout.session.completed", () => {
      expect(
        resolveStripeWebhookGrant(
          event(
            "checkout.session.completed",
            checkoutSession({
              id: "cs_paid",
              metadata: { userId: "user_2", grantMillicredits: "500000", entryId: "extra" },
            }),
          ),
        ),
      ).toEqual({
        userId: "user_2",
        amountMillicredits: "500000",
        source: "stripe",
        stripeIdempotencyId: "cs_paid",
        displayReason: "Extra usage",
      });
    });
    it("does not grant for subscription checkout.session.completed", () => {
      expect(
        resolveStripeWebhookGrant(
          event("checkout.session.completed", checkoutSession({ mode: "subscription" })),
        ),
      ).toBeNull();
    });
    it("grants subscription credits from invoice.paid line period and mapped price", () => {
      expect(
        resolveStripeWebhookGrant(
          event("invoice.paid", {
            id: "in_123",
            parent: {
              subscription_details: {
                subscription: "sub_123",
                metadata: { userId: "user_sub" },
              },
            },
            lines: {
              data: [
                {
                  id: "il_proration",
                  period: { start: 1780272000, end: 1782864000 },
                  parent: {
                    subscription_item_details: { subscription: "sub_123", proration: true },
                  },
                },
                {
                  id: "il_period",
                  period: { start: 1782864000, end: 1785542400 },
                  pricing: { price_details: { price: "price_standard" } },
                  parent: { subscription_item_details: { subscription: "sub_123" } },
                },
              ],
            },
          }),
          {
            planPrices: [
              {
                entryId: "plan_standard",
                stripePriceId: "price_standard",
                grantMillicredits: "1000000",
              },
            ],
          },
        ),
      ).toEqual({
        userId: "user_sub",
        amountMillicredits: "1000000",
        source: "subscription",
        stripeIdempotencyId: "il_period",
        displayReason: "Monthly usage",
        expiresAt: "2026-08-01T00:00:00.000Z",
        metadata: { entryId: "plan_standard" },
      });
    });
    it("uses the paid invoice line price to resolve subscription grant amount after portal plan changes", () => {
      expect(
        resolveStripeWebhookGrant(
          event("invoice.paid", {
            id: "in_123",
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
                  id: "il_period",
                  period: { start: 1782864000, end: 1785542400 },
                  pricing: { price_details: { price: "price_premium" } },
                  parent: { subscription_item_details: { subscription: "sub_123" } },
                },
              ],
            },
          }),
          {
            planPrices: [
              {
                entryId: "plan_standard",
                stripePriceId: "price_standard",
                grantMillicredits: "1000000",
              },
              {
                entryId: "plan_premium",
                stripePriceId: "price_premium",
                grantMillicredits: "2800000",
              },
            ],
          },
        ),
      ).toMatchObject({
        amountMillicredits: "2800000",
        metadata: { entryId: "plan_premium" },
      });
    });
    it("rejects subscription invoices with unknown Stripe price IDs so Stripe retries", () => {
      expect(() =>
        resolveStripeWebhookGrant(
          event("invoice.paid", {
            id: "in_123",
            parent: {
              subscription_details: { subscription: "sub_123", metadata: { userId: "user_sub" } },
            },
            lines: {
              data: [
                {
                  id: "il_period",
                  period: { start: 1782864000, end: 1785542400 },
                  pricing: { price_details: { price: "price_rotated" } },
                  parent: { subscription_item_details: { subscription: "sub_123" } },
                },
              ],
            },
          }),
          {
            planPrices: [
              {
                entryId: "plan_standard",
                stripePriceId: "price_standard",
                grantMillicredits: "1000000",
              },
            ],
          },
        ),
      ).toThrow("Unknown Stripe subscription price ID: price_rotated");
    });
    it("rejects subscription invoices without a line price ID so Stripe retries", () => {
      expect(() =>
        resolveStripeWebhookGrant(
          event("invoice.paid", {
            id: "in_123",
            parent: {
              subscription_details: { subscription: "sub_123", metadata: { userId: "user_sub" } },
            },
            lines: {
              data: [
                {
                  id: "il_period",
                  period: { start: 1782864000, end: 1785542400 },
                  parent: { subscription_item_details: { subscription: "sub_123" } },
                },
              ],
            },
          }),
          {
            planPrices: [
              {
                entryId: "plan_standard",
                stripePriceId: "price_standard",
                grantMillicredits: "1000000",
              },
            ],
          },
        ),
      ).toThrow("Stripe subscription invoice line is missing a price ID");
    });
    it("does not grant from a proration-only invoice.paid", () => {
      expect(
        resolveStripeWebhookGrant(
          event("invoice.paid", {
            id: "in_proration",
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
                  id: "il_proration_only",
                  period: { start: 1780272000, end: 1782864000 },
                  parent: {
                    subscription_item_details: { subscription: "sub_123", proration: true },
                  },
                },
              ],
            },
          }),
        ),
      ).toBeNull();
    });
    it("ignores unrelated events", () => {
      expect(resolveStripeWebhookGrant(event("customer.created", { id: "cus_123" }))).toBeNull();
    });
  });
});

__mergedSuite("free-grants.test.ts", () => {
  // Merged from apps/server/server/domains/billing/domain/free-grants.test.ts.
  const userId = "user-1";

  const clock = { now: () => new Date("2026-06-12T00:00:00.000Z") };

  __mergedSuite("ensureFreeTier", () => {
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
  });
});
