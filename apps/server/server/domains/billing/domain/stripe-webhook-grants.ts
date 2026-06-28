/** Resolves Stripe webhook payloads into ledger grants; owns Meridian billing policy. */
import type { BillingPlanPriceBinding } from "./catalog.js";
import type { CreditGrantInput } from "./credit-ledger.js";

export interface StripeWebhookEventLike {
  type: string;
  data: { object: unknown };
}

type MetadataLike = Record<string, string> | null | undefined;

type CheckoutSessionLike = {
  id?: string;
  mode?: string | null;
  payment_status?: string | null;
  metadata?: MetadataLike;
};

type InvoiceLineLike = {
  id?: string | null;
  period?: { start?: number | null; end?: number | null } | null;
  subscription?: string | { id?: string | null } | null;
  price?: { id?: string | null } | null;
  plan?: { id?: string | null } | null;
  pricing?: { price_details?: { price?: string | null } | null } | null;
  parent?: {
    subscription_item_details?: {
      subscription?: string | { id?: string | null } | null;
      proration?: boolean | null;
    } | null;
    invoice_item_details?: {
      subscription?: string | { id?: string | null } | null;
      proration?: boolean | null;
    } | null;
  } | null;
};

type InvoiceLike = {
  id?: string;
  metadata?: MetadataLike;
  parent?: {
    subscription_details?: {
      subscription?: string | { id?: string | null } | null;
      metadata?: MetadataLike;
    } | null;
  } | null;
  lines?: { data?: InvoiceLineLike[] } | null;
};

export type StripeWebhookGrant = CreditGrantInput & {
  source: "stripe" | "subscription";
  stripeIdempotencyId: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

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

function objectId(value: string | { id?: string | null } | null | undefined): string | null {
  if (typeof value === "string") return value;
  return value?.id ?? null;
}

function subscriptionIdFromLine(line: InvoiceLineLike): string | null {
  return objectId(
    line.subscription ??
      line.parent?.subscription_item_details?.subscription ??
      line.parent?.invoice_item_details?.subscription,
  );
}

function subscriptionIdFromInvoice(invoice: InvoiceLike): string | null {
  return objectId(invoice.parent?.subscription_details?.subscription);
}

function isProrationLine(line: InvoiceLineLike): boolean {
  return Boolean(
    line.parent?.subscription_item_details?.proration ??
      line.parent?.invoice_item_details?.proration,
  );
}

function subscriptionGrantLine(invoice: InvoiceLike): InvoiceLineLike | null {
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  const candidates = (invoice.lines?.data ?? []).filter((line) => {
    if (!line.period?.start || !line.period.end) return false;
    const lineSubscriptionId = subscriptionIdFromLine(line);
    if (!subscriptionId) return Boolean(lineSubscriptionId);
    return lineSubscriptionId === subscriptionId;
  });
  return candidates.find((line) => !isProrationLine(line)) ?? null;
}

function priceIdFromLine(line: InvoiceLineLike): string | null {
  return line.pricing?.price_details?.price ?? line.price?.id ?? line.plan?.id ?? null;
}

function isoFromStripeSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function checkoutSession(value: unknown): CheckoutSessionLike | null {
  const candidate = record(value);
  if (!candidate) return null;
  return candidate as CheckoutSessionLike;
}

function invoice(value: unknown): InvoiceLike | null {
  const candidate = record(value);
  if (!candidate) return null;
  return candidate as InvoiceLike;
}

function resolvePaidCheckoutSession(session: CheckoutSessionLike): StripeWebhookGrant | null {
  if (session.mode === "subscription") return null;
  if (session.mode !== "payment" || session.payment_status !== "paid" || !session.id) return null;
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

function resolvePaidInvoice(
  paidInvoice: InvoiceLike,
  plansByPriceId: ReadonlyMap<string, BillingPlanPriceBinding>,
): StripeWebhookGrant | null {
  const metadataSource = paidInvoice.parent?.subscription_details?.metadata ?? paidInvoice.metadata;
  const userId = metadataString(metadataSource, "userId");
  if (!userId) return null;

  const line = subscriptionGrantLine(paidInvoice);
  if (!line?.id || !line.period?.end) return null;

  const linePriceId = priceIdFromLine(line);
  if (!linePriceId) {
    throw new Error("Stripe subscription invoice line is missing a price ID");
  }
  const catalogPlan = plansByPriceId.get(linePriceId);
  if (!catalogPlan) {
    throw new Error(`Unknown Stripe subscription price ID: ${linePriceId}`);
  }

  return {
    userId,
    amountMillicredits: catalogPlan.grantMillicredits,
    source: "subscription",
    stripeIdempotencyId: line.id,
    displayReason: "Monthly usage",
    expiresAt: isoFromStripeSeconds(line.period.end),
    metadata: { entryId: catalogPlan.entryId },
  };
}

export function resolveStripeWebhookGrant(
  event: StripeWebhookEventLike,
  input: { planPrices?: readonly BillingPlanPriceBinding[] } = {},
): StripeWebhookGrant | null {
  const plansByPriceId = new Map(
    (input.planPrices ?? []).map((plan) => [plan.stripePriceId, plan] as const),
  );
  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {
    const session = checkoutSession(event.data.object);
    return session ? resolvePaidCheckoutSession(session) : null;
  }
  if (event.type === "invoice.paid") {
    const paidInvoice = invoice(event.data.object);
    return paidInvoice ? resolvePaidInvoice(paidInvoice, plansByPriceId) : null;
  }
  return null;
}
