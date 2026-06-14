import type { BillingCatalogEntry } from "@meridian/contracts/protocol";
import Stripe from "stripe";
import { stripePriceIdFor } from "../../domain/catalog.js";
import type { PaymentProvider, PaymentWebhookEvent } from "../../ports/payment-provider.js";

export interface StripePaymentProviderConfig {
  secretKey: string;
  webhookSecret: string;
  env: NodeJS.ProcessEnv;
}

function secondsToIso(value: number | null | undefined): string | null {
  return value ? new Date(value * 1000).toISOString() : null;
}

function metadataString(metadata: Stripe.Metadata | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function subscriptionItemPeriod(subscription: Stripe.Subscription): {
  periodStart: number | null;
  periodEnd: number | null;
} {
  const item = subscription.items?.data?.[0];
  return {
    periodStart: item?.current_period_start ?? null,
    periodEnd: item?.current_period_end ?? null,
  };
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const subscription = invoice.parent?.subscription_details?.subscription;
  if (typeof subscription === "string") return subscription;
  if (subscription && typeof subscription === "object" && "id" in subscription) {
    return typeof subscription.id === "string" ? subscription.id : null;
  }
  return null;
}

function invoiceLineSubscriptionId(line: Stripe.InvoiceLineItem): string | null {
  const candidate = line as Stripe.InvoiceLineItem & {
    subscription?: string | { id?: string } | null;
    parent?: {
      subscription_item_details?: { subscription?: string | { id?: string } | null };
      invoice_item_details?: { subscription?: string | { id?: string } | null };
    } | null;
  };
  const subscription =
    candidate.subscription ??
    candidate.parent?.subscription_item_details?.subscription ??
    candidate.parent?.invoice_item_details?.subscription;
  if (typeof subscription === "string") return subscription;
  return subscription?.id ?? null;
}

function invoiceLineIsProration(line: Stripe.InvoiceLineItem): boolean {
  const candidate = line as Stripe.InvoiceLineItem & {
    parent?: {
      subscription_item_details?: { proration?: boolean | null };
      invoice_item_details?: { proration?: boolean | null };
    } | null;
  };
  return Boolean(
    candidate.parent?.subscription_item_details?.proration ??
      candidate.parent?.invoice_item_details?.proration,
  );
}

export function stripeInvoiceBilledPeriodForSubscription(
  invoice: Stripe.Invoice,
  subscriptionId: string,
): {
  periodStart: string | null;
  periodEnd: string | null;
} {
  const matchingLines = invoice.lines.data.filter(
    (candidate) =>
      candidate.period?.start &&
      candidate.period.end &&
      invoiceLineSubscriptionId(candidate) === subscriptionId,
  );
  const line =
    matchingLines.find((candidate) => !invoiceLineIsProration(candidate)) ?? matchingLines[0];
  return {
    periodStart: secondsToIso(line?.period?.start ?? null),
    periodEnd: secondsToIso(line?.period?.end ?? null),
  };
}

async function subscriptionDetails(
  stripe: Stripe,
  subscriptionId: string | null,
): Promise<{
  periodStart: string | null;
  periodEnd: string | null;
  metadata: Stripe.Metadata;
  status: Stripe.Subscription.Status | null;
  cancelAtPeriodEnd: boolean;
}> {
  if (!subscriptionId) {
    return {
      periodStart: null,
      periodEnd: null,
      metadata: {},
      status: null,
      cancelAtPeriodEnd: false,
    };
  }
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const period = subscriptionItemPeriod(subscription);
  return {
    periodStart: secondsToIso(period.periodStart),
    periodEnd: secondsToIso(period.periodEnd),
    metadata: subscription.metadata ?? {},
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  };
}

function mapSubscriptionStatus(
  status: Stripe.Subscription.Status | null,
): "active" | "past_due" | "cancelled" | "trialing" {
  if (status === "past_due") return "past_due";
  if (status === "trialing") return "trialing";
  if (status === "canceled" || status === "unpaid" || status === "incomplete_expired") {
    return "cancelled";
  }
  return "active";
}

function normalizeCheckoutSession(
  session: Stripe.Checkout.Session,
  period: { periodStart: string | null; periodEnd: string | null },
): PaymentWebhookEvent {
  const userId = metadataString(session.metadata, "userId");
  const projectId = metadataString(session.metadata, "projectId");
  const entryId = metadataString(session.metadata, "entryId");
  if (!userId || !entryId) {
    return { kind: "ignored", eventType: "checkout.session.completed" };
  }
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : (session.subscription?.id ?? null);
  const customerId =
    typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null);
  return {
    kind: "checkout.completed",
    sessionId: session.id,
    userId,
    projectId,
    entryId,
    customerId,
    subscriptionId,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
  };
}

function normalizeInvoicePaid(
  invoice: Stripe.Invoice,
  subscription: {
    periodStart: string | null;
    periodEnd: string | null;
    metadata: Stripe.Metadata;
    status: Stripe.Subscription.Status | null;
    cancelAtPeriodEnd: boolean;
  },
  subscriptionId: string,
): PaymentWebhookEvent {
  const metadata = subscription.metadata;
  const userId = metadataString(metadata, "userId");
  const projectId = metadataString(metadata, "projectId");
  const entryId = metadataString(metadata, "entryId");
  if (!userId || !entryId) {
    return { kind: "ignored", eventType: "invoice.paid" };
  }
  const customerId =
    typeof invoice.customer === "string" ? invoice.customer : (invoice.customer?.id ?? null);
  if (!customerId) return { kind: "ignored", eventType: "invoice.paid" };

  const invoicePeriod = stripeInvoiceBilledPeriodForSubscription(invoice, subscriptionId);
  const periodStart =
    invoicePeriod.periodStart ?? subscription.periodStart ?? new Date().toISOString();
  const periodEnd = invoicePeriod.periodEnd ?? subscription.periodEnd ?? periodStart;

  return {
    kind: "checkout.completed",
    sessionId: invoice.id,
    userId,
    projectId,
    entryId,
    customerId,
    subscriptionId,
    periodStart,
    periodEnd,
  };
}

function normalizeSubscriptionUpdated(subscription: Stripe.Subscription): PaymentWebhookEvent {
  const userId = metadataString(subscription.metadata, "userId");
  const projectId = metadataString(subscription.metadata, "projectId");
  const entryId = metadataString(subscription.metadata, "entryId");
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : (subscription.customer?.id ?? null);
  if (!userId || !entryId || !customerId) {
    return { kind: "ignored", eventType: "customer.subscription.updated" };
  }

  const period = subscriptionItemPeriod(subscription);
  const periodStart = secondsToIso(period.periodStart);
  const periodEnd = secondsToIso(period.periodEnd);
  if (!periodStart || !periodEnd) {
    return { kind: "ignored", eventType: "customer.subscription.updated" };
  }

  return {
    kind: "subscription.updated",
    subscriptionId: subscription.id,
    userId,
    projectId,
    entryId,
    customerId,
    status: mapSubscriptionStatus(subscription.status),
    creditsPerPeriod: metadataString(subscription.metadata, "millicredits") ?? "0",
    periodStart,
    periodEnd,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  };
}

export function createStripePaymentProvider(config: StripePaymentProviderConfig): PaymentProvider {
  const stripe = new Stripe(config.secretKey);

  return {
    status() {
      return { mode: "stripe", needsCredentials: false, message: null };
    },

    async createCheckoutSession(input) {
      const price = stripePriceIdFor(input.entry, config.env);
      if (!price) {
        throw new Error(`Missing ${input.entry.stripePriceEnv} for ${input.entry.id}`);
      }
      const session = await stripe.checkout.sessions.create({
        mode: input.entry.kind === "plan" ? "subscription" : "payment",
        line_items: [{ price, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.userId,
        metadata: {
          userId: input.userId,
          projectId: input.projectId,
          entryId: input.entry.id,
          millicredits: input.entry.millicredits,
        },
        subscription_data:
          input.entry.kind === "plan"
            ? {
                metadata: {
                  userId: input.userId,
                  projectId: input.projectId,
                  entryId: input.entry.id,
                  millicredits: input.entry.millicredits,
                },
              }
            : undefined,
      });
      if (!session.url) throw new Error("Stripe checkout session did not include a URL");
      return { id: session.id, url: session.url, mode: "stripe", needsCredentials: false };
    },

    async verifyWebhook(input) {
      if (!input.signature) throw new Error("Missing Stripe signature");
      const event = stripe.webhooks.constructEvent(
        input.payload,
        input.signature,
        config.webhookSecret,
      );

      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;
        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : (session.subscription?.id ?? null);
        const period = await subscriptionDetails(stripe, subscriptionId);
        return normalizeCheckoutSession(session, period);
      }

      if (event.type === "invoice.paid") {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = invoiceSubscriptionId(invoice);
        if (!subscriptionId) return { kind: "ignored", eventType: event.type };
        const subscription = await subscriptionDetails(stripe, subscriptionId);
        return normalizeInvoicePaid(invoice, subscription, subscriptionId);
      }

      if (
        event.type === "customer.subscription.updated" ||
        event.type === "customer.subscription.deleted"
      ) {
        const subscription = event.data.object as Stripe.Subscription;
        const normalized = normalizeSubscriptionUpdated(subscription);
        if (
          normalized.kind === "subscription.updated" &&
          event.type === "customer.subscription.deleted"
        ) {
          return { ...normalized, status: "cancelled" };
        }
        return normalized;
      }

      return { kind: "ignored", eventType: event.type };
    },
  };
}

export function stripeReady(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}

export function missingStripeConfigEntry(env: NodeJS.ProcessEnv): BillingCatalogEntry | null {
  if (stripeReady(env)) return null;
  return {
    id: "needs_stripe_credentials",
    kind: "needs-credentials",
    name: "Stripe credentials needed",
    description:
      "Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and price ids to use live checkout.",
    credits: 0,
    millicredits: "0",
    priceUsd: "0.00",
    needsCredentials: true,
  };
}
