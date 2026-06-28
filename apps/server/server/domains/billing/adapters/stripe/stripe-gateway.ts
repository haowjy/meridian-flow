import Stripe from "stripe";
import { millicreditsToStripeCents } from "../../domain/money.js";

export type StripeWebhookEvent = Stripe.Event;

export interface StripeBillingGateway {
  createCustomer(input: { userId: string }): Promise<{ id: string }>;
  createCheckoutSession(input: StripeCheckoutInput): Promise<{ id: string; url: string }>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  getLiveSubscription(customerId: string): Promise<{ id: string; status: string } | null>;
  constructWebhookEvent(input: { rawBody: string; signature: string }): StripeWebhookEvent;
}

export interface StripeCheckoutInput {
  customerId: string;
  userId: string;
  entry: {
    kind: "plan" | "extra-usage";
    grantMillicredits: string;
    catalogId?: string;
    interval?: string;
  };
  stripePriceId: string | null;
  successUrl: string;
  cancelUrl: string;
}

type StripeGatewayConfig = {
  secretKey: string;
  webhookSecret: string;
};

const LIVE_SUBSCRIPTION_STATUSES = new Set(["active", "past_due", "trialing"]);

function entryId(input: StripeCheckoutInput): string {
  return input.entry.catalogId ?? input.entry.kind;
}

function requirePlanPriceId(stripePriceId: string | null): string {
  if (!stripePriceId) throw new Error("Plan checkout requires a Stripe Price ID");
  return stripePriceId;
}

function checkoutMetadata(input: StripeCheckoutInput): Stripe.MetadataParam {
  return {
    userId: input.userId,
    grantMillicredits: input.entry.grantMillicredits,
    entryId: entryId(input),
  };
}

export function createStripeBillingGateway(config: StripeGatewayConfig): StripeBillingGateway {
  const stripe = new Stripe(config.secretKey);

  return {
    async createCustomer(input) {
      const customer = await stripe.customers.create(
        { metadata: { userId: input.userId } },
        { idempotencyKey: `meridian_customer_${input.userId}` },
      );
      return { id: customer.id };
    },

    async createCheckoutSession(input) {
      const lineItem: Stripe.Checkout.SessionCreateParams.LineItem =
        input.entry.kind === "plan"
          ? { price: requirePlanPriceId(input.stripePriceId), quantity: 1 }
          : {
              price_data: {
                currency: "usd",
                product_data: { name: "Extra usage" },
                unit_amount: millicreditsToStripeCents(input.entry.grantMillicredits),
              },
              quantity: 1,
            };
      const metadata = checkoutMetadata(input);
      const session = await stripe.checkout.sessions.create({
        mode: input.entry.kind === "plan" ? "subscription" : "payment",
        customer: input.customerId,
        line_items: [lineItem],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.userId,
        metadata,
        subscription_data: input.entry.kind === "plan" ? { metadata } : undefined,
      });
      if (!session.url) throw new Error("Stripe checkout session did not include a URL");
      return { id: session.id, url: session.url };
    },

    async createPortalSession(input) {
      const session = await stripe.billingPortal.sessions.create({
        customer: input.customerId,
        return_url: input.returnUrl,
      });
      return { url: session.url };
    },

    async getLiveSubscription(customerId) {
      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 100,
      });
      const subscription = subscriptions.data.find((candidate) =>
        LIVE_SUBSCRIPTION_STATUSES.has(candidate.status),
      );
      return subscription ? { id: subscription.id, status: subscription.status } : null;
    },

    constructWebhookEvent(input) {
      return stripe.webhooks.constructEvent(input.rawBody, input.signature, config.webhookSecret);
    },
  };
}
