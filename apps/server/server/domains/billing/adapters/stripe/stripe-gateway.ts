import Stripe from "stripe";
import { millicreditsToStripeCents } from "../../domain/money.js";

export type StripeWebhookEvent = Stripe.Event;

export interface StripeBillingGateway {
  createCustomer(input: { userId: string }): Promise<{ id: string }>;
  createCheckoutSession(input: StripeCheckoutInput): Promise<{ id: string; url: string }>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  getLiveSubscription(customerId: string): Promise<{ id: string; status: string } | null>;
  constructWebhookEvent(input: { rawBody: string; signature: string }): StripeWebhookEvent;
  resolveCheckoutGrant(event: StripeWebhookEvent): Promise<CheckoutGrantResolution | null>;
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

export interface CheckoutGrantResolution {
  userId: string;
  amountMillicredits: string;
  source: "stripe" | "subscription";
  stripeIdempotencyId: string;
  displayReason?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

type StripeGatewayConfig = { secretKey: string; webhookSecret: string };

type MetadataLike = Record<string, string> | Stripe.Metadata | null | undefined;

type InvoiceLineWithSubscriptionDetails = Stripe.InvoiceLineItem & {
  subscription?: string | { id?: string } | null;
  parent?: {
    subscription_item_details?: {
      subscription?: string | { id?: string } | null;
      proration?: boolean | null;
    } | null;
    invoice_item_details?: {
      subscription?: string | { id?: string } | null;
      proration?: boolean | null;
    } | null;
  } | null;
};

type InvoiceWithSubscriptionMetadata = Stripe.Invoice & {
  parent?: {
    subscription_details?: {
      subscription?: string | { id?: string } | null;
      metadata?: Stripe.Metadata | null;
    } | null;
  } | null;
};

const LIVE_SUBSCRIPTION_STATUSES = new Set(["active", "past_due", "trialing"]);

function metadataString(metadata: MetadataLike, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function grantMetadata(
  metadata: MetadataLike,
): { userId: string; grantMillicredits: string } | null {
  const userId = metadataString(metadata, "userId");
  const grantMillicredits = metadataString(metadata, "grantMillicredits");
  return userId && grantMillicredits ? { userId, grantMillicredits } : null;
}

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

function subscriptionIdFromLine(line: Stripe.InvoiceLineItem): string | null {
  const candidate = line as InvoiceLineWithSubscriptionDetails;
  const subscription =
    candidate.subscription ??
    candidate.parent?.subscription_item_details?.subscription ??
    candidate.parent?.invoice_item_details?.subscription;
  if (typeof subscription === "string") return subscription;
  return subscription?.id ?? null;
}

function subscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const subscription = (invoice as InvoiceWithSubscriptionMetadata).parent?.subscription_details
    ?.subscription;
  if (typeof subscription === "string") return subscription;
  return subscription?.id ?? null;
}

function isProrationLine(line: Stripe.InvoiceLineItem): boolean {
  const candidate = line as InvoiceLineWithSubscriptionDetails;
  return Boolean(
    candidate.parent?.subscription_item_details?.proration ??
      candidate.parent?.invoice_item_details?.proration,
  );
}

function subscriptionGrantLine(invoice: Stripe.Invoice): Stripe.InvoiceLineItem | null {
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  const candidates = invoice.lines.data.filter((line) => {
    if (!line.period?.start || !line.period.end) return false;
    const lineSubscriptionId = subscriptionIdFromLine(line);
    if (!subscriptionId) return Boolean(lineSubscriptionId);
    return lineSubscriptionId === subscriptionId;
  });
  return candidates.find((line) => !isProrationLine(line)) ?? candidates[0] ?? null;
}

function isoFromStripeSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function resolvePaidCheckoutSession(
  session: Stripe.Checkout.Session,
): CheckoutGrantResolution | null {
  if (session.mode === "subscription") return null;
  if (session.mode !== "payment" || session.payment_status !== "paid") return null;
  const metadata = grantMetadata(session.metadata);
  if (!metadata) return null;
  return {
    userId: metadata.userId,
    amountMillicredits: metadata.grantMillicredits,
    source: "stripe",
    stripeIdempotencyId: session.id,
    displayReason: "Extra usage",
  };
}

function resolvePaidInvoice(invoice: Stripe.Invoice): CheckoutGrantResolution | null {
  const metadataSource =
    (invoice as InvoiceWithSubscriptionMetadata).parent?.subscription_details?.metadata ??
    invoice.metadata;
  const metadata = grantMetadata(metadataSource);
  if (!metadata) return null;

  const line = subscriptionGrantLine(invoice);
  if (!line?.id || !line.period?.end) return null;

  const catalogEntryId = metadataString(metadataSource, "entryId");
  return {
    userId: metadata.userId,
    amountMillicredits: metadata.grantMillicredits,
    source: "subscription",
    stripeIdempotencyId: line.id,
    displayReason: "Monthly usage",
    expiresAt: isoFromStripeSeconds(line.period.end),
    ...(catalogEntryId ? { metadata: { entryId: catalogEntryId } } : {}),
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

    async resolveCheckoutGrant(event) {
      if (
        event.type === "checkout.session.completed" ||
        event.type === "checkout.session.async_payment_succeeded"
      ) {
        return resolvePaidCheckoutSession(event.data.object as Stripe.Checkout.Session);
      }
      if (event.type === "invoice.paid") {
        return resolvePaidInvoice(event.data.object as Stripe.Invoice);
      }
      return null;
    },
  };
}
