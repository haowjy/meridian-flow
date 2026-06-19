import type {
  BillingBalanceResponse,
  BillingPacksPlansResponse,
  BillingTransactionsResponse,
  BillingWebhookResponse,
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResponse,
} from "@meridian/contracts/protocol";
import {
  missingStripeConfigEntry,
  stripeReady,
} from "../domains/billing/adapters/stripe/payment-provider.js";
import { BILLING_CATALOG, catalogEntry } from "../domains/billing/domain/catalog.js";
import type { CreditLedger } from "../domains/billing/domain/credit-ledger.js";
import type {
  PaymentProvider,
  PaymentWebhookEvent,
} from "../domains/billing/ports/payment-provider.js";
import type { SubscriptionStore } from "../domains/billing/ports/subscription-store.js";

export interface BillingRouteDeps {
  ledger: CreditLedger;
  paymentProvider: PaymentProvider;
  subscriptionStore: SubscriptionStore;
  env: NodeJS.ProcessEnv;
  resolveDefaultProjectId?: (userId: string) => Promise<string>;
}

export function createBillingRouteDeps(
  app: {
    creditLedger: CreditLedger;
    paymentProvider: PaymentProvider;
    subscriptionStore: SubscriptionStore;
  },
  env: NodeJS.ProcessEnv,
  resolveDefaultProjectId?: (userId: string) => Promise<string>,
): BillingRouteDeps {
  return {
    ledger: app.creditLedger,
    paymentProvider: app.paymentProvider,
    subscriptionStore: app.subscriptionStore,
    env,
    resolveDefaultProjectId,
  };
}

export async function billingBalance(
  deps: BillingRouteDeps,
  input: { userId: string; projectId: string },
): Promise<BillingBalanceResponse> {
  return deps.ledger.getBalanceBreakdown(input);
}

export async function billingTransactions(
  deps: BillingRouteDeps,
  input: { userId: string; projectId: string; limit?: number },
): Promise<BillingTransactionsResponse> {
  const transactions = await deps.ledger.listTransactions(input);
  const totalConsumed = transactions.reduce((sum, tx) => {
    const amount = BigInt(tx.amountMillicredits);
    return amount < 0n ? sum - amount : sum;
  }, 0n);
  return {
    transactions,
    usage: {
      totalConsumedMillicredits: totalConsumed.toString(),
      transactionCount: transactions.length,
    },
  };
}

export function billingPacksPlans(deps: BillingRouteDeps): BillingPacksPlansResponse {
  const needsCredentialsEntry = missingStripeConfigEntry(deps.env);
  return {
    entries: needsCredentialsEntry
      ? [needsCredentialsEntry, ...BILLING_CATALOG.entries]
      : BILLING_CATALOG.entries,
    provider: deps.paymentProvider.status(),
  };
}

function checkoutOrigin(url: string): string {
  const parsed = new URL(url);
  return parsed.origin;
}

function subscriptionGrantReason(event: {
  subscriptionId: string | null;
  sessionId: string;
  periodStart: string | null;
}): string {
  return `subscription:${event.subscriptionId ?? event.sessionId}:${event.periodStart ?? "checkout"}`;
}

async function grantCheckout(
  ledger: CreditLedger,
  event: Extract<PaymentWebhookEvent, { kind: "checkout.completed" }>,
  projectId: string,
): Promise<void> {
  const entry = catalogEntry(event.entryId);
  if (!entry?.kind || entry.kind === "payg" || entry.kind === "needs-credentials") return;

  if (entry.kind === "plan") {
    const grantReason = subscriptionGrantReason(event);
    await ledger.grant({
      userId: event.userId,
      projectId,
      source: "subscription",
      amountMillicredits: entry.millicredits,
      reason: grantReason,
      expiresAt: event.periodEnd,
      metadata: {
        entryId: event.entryId,
        stripeSessionId: event.sessionId,
        stripeCustomerId: event.customerId,
        stripeSubscriptionId: event.subscriptionId,
        periodStart: event.periodStart,
        periodEnd: event.periodEnd,
      },
    });
    return;
  }

  await ledger.grant({
    userId: event.userId,
    projectId,
    source: "stripe",
    amountMillicredits: entry.millicredits,
    stripeSessionId: event.sessionId,
    metadata: { entryId: event.entryId, stripeCustomerId: event.customerId },
  });
}

async function persistSubscriptionCheckout(
  store: SubscriptionStore,
  event: Extract<PaymentWebhookEvent, { kind: "checkout.completed" }>,
): Promise<void> {
  const entry = catalogEntry(event.entryId);
  if (entry?.kind !== "plan" || !event.subscriptionId || !event.customerId) return;
  if (!event.periodStart || !event.periodEnd) {
    throw new Error("Subscription checkout missing billing period");
  }

  await store.upsert({
    userId: event.userId,
    stripeSubscriptionId: event.subscriptionId,
    stripeCustomerId: event.customerId,
    plan: "pro",
    status: "active",
    creditsPerPeriod: entry.millicredits,
    currentPeriodStart: event.periodStart,
    currentPeriodEnd: event.periodEnd,
    cancelAtPeriodEnd: false,
  });
}

async function persistSubscriptionUpdate(
  store: SubscriptionStore,
  event: Extract<PaymentWebhookEvent, { kind: "subscription.updated" }>,
): Promise<void> {
  const entry = catalogEntry(event.entryId);
  if (entry?.kind !== "plan") return;

  await store.upsert({
    userId: event.userId,
    stripeSubscriptionId: event.subscriptionId,
    stripeCustomerId: event.customerId,
    plan: "pro",
    status: event.status,
    creditsPerPeriod: entry.millicredits,
    currentPeriodStart: event.periodStart,
    currentPeriodEnd: event.periodEnd,
    cancelAtPeriodEnd: event.cancelAtPeriodEnd,
  });
}

export async function createBillingCheckoutSession(
  deps: BillingRouteDeps,
  input: { userId: string; projectId: string; body: CreateCheckoutSessionRequest },
): Promise<CreateCheckoutSessionResponse> {
  const entry = catalogEntry(input.body.entryId);
  if (!entry?.kind || entry.kind === "needs-credentials") throw new Error("Unknown billing entry");
  if (entry.kind === "payg") throw new Error("Pay as you go does not require checkout");

  const session = await deps.paymentProvider.createCheckoutSession({
    userId: input.userId,
    projectId: input.projectId,
    entry,
    successUrl: input.body.successUrl,
    cancelUrl: input.body.cancelUrl,
  });

  if (session.mode === "fake") {
    const checkoutEvent: Extract<PaymentWebhookEvent, { kind: "checkout.completed" }> = {
      kind: "checkout.completed",
      sessionId: session.id,
      userId: input.userId,
      projectId: input.projectId,
      entryId: entry.id,
      customerId: "fake_customer",
      subscriptionId: entry.kind === "plan" ? `fake_sub_${input.userId}` : null,
      periodStart: new Date().toISOString(),
      periodEnd:
        entry.kind === "plan"
          ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
          : null,
    };
    await persistSubscriptionCheckout(deps.subscriptionStore, checkoutEvent);
    await grantCheckout(deps.ledger, checkoutEvent, input.projectId);
  }

  return {
    sessionId: session.id,
    url: session.url || `${checkoutOrigin(input.body.successUrl)}/billing`,
    mode: session.mode,
    needsCredentials: session.needsCredentials,
  };
}

export async function handleBillingWebhook(
  deps: BillingRouteDeps,
  input: { payload: string; signature: string | null; defaultProjectId?: string },
): Promise<BillingWebhookResponse> {
  if (!stripeReady(deps.env)) {
    throw new Error(
      "Stripe webhook is disabled until STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are configured",
    );
  }

  const event = await deps.paymentProvider.verifyWebhook(input);
  if (event.kind === "ignored") return { received: true, action: "ignored" };

  if (event.kind === "subscription.updated") {
    await persistSubscriptionUpdate(deps.subscriptionStore, event);
    return { received: true, action: "subscription_updated" };
  }

  const projectId =
    event.projectId ??
    input.defaultProjectId ??
    (await deps.resolveDefaultProjectId?.(event.userId));
  if (!projectId) throw new Error("Billing webhook did not resolve a project");

  await persistSubscriptionCheckout(deps.subscriptionStore, event);
  await grantCheckout(deps.ledger, event, projectId);
  return { received: true, action: "granted" };
}
