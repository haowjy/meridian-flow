import type {
  BillingBalanceResponse,
  BillingProductsResponse,
  BillingTransaction,
  BillingTransactionsResponse,
  BillingWebhookResponse,
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResponse,
} from "@meridian/contracts/protocol";
import type { StripeBillingGateway } from "../domains/billing/adapters/stripe/stripe-gateway.js";
import {
  BILLING_PLANS,
  type BillingCatalogServerEntry,
  type BillingPlanCatalogEntry,
  catalogEntry,
  EXTRA_USAGE,
  publicCatalogEntry,
} from "../domains/billing/domain/catalog.js";
import type {
  CreditLedger,
  CreditLotView,
  CreditTransactionRow,
} from "../domains/billing/domain/credit-ledger.js";

export class BillingRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingRequestError";
  }
}

export interface BillingRouteDeps {
  ledger: CreditLedger;
  stripeGateway: StripeBillingGateway | null;
  freeTier: { ensure: (userId: string) => Promise<void> };
  getOrCreateStripeCustomer: (userId: string) => Promise<string>;
  env: NodeJS.ProcessEnv;
}

export function createBillingRouteDeps(
  app: {
    creditLedger: CreditLedger;
    stripeGateway: StripeBillingGateway | null;
    freeTier: { ensure: (userId: string) => Promise<void> };
    getOrCreateStripeCustomer: (userId: string) => Promise<string>;
  },
  env: NodeJS.ProcessEnv,
): BillingRouteDeps {
  return {
    ledger: app.creditLedger,
    stripeGateway: app.stripeGateway,
    freeTier: app.freeTier,
    getOrCreateStripeCustomer: app.getOrCreateStripeCustomer,
    env,
  };
}

function isUnexpired(lot: CreditLotView, now = new Date()): boolean {
  return lot.expiresAt === null || new Date(lot.expiresAt).getTime() > now.getTime();
}

function millicreditsToUsd(value: string | bigint): string {
  const raw = typeof value === "bigint" ? value : BigInt(value);
  const sign = raw < 0n ? "-" : "";
  const absolute = raw < 0n ? -raw : raw;
  const whole = absolute / 100_000n;
  const fraction = absolute % 100_000n;
  if (fraction === 0n) return `${sign}${whole}`;
  return `${sign}${whole}.${fraction.toString().padStart(5, "0").replace(/0+$/, "")}`;
}

function parseUsdToMillicredits(value: string): bigint {
  if (!/^\d+(?:\.\d{1,5})?$/.test(value)) {
    throw new BillingRequestError(
      "amountUsd must be a positive USD decimal with at most 5 decimal places",
    );
  }
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 100_000n + BigInt(fraction.padEnd(5, "0"));
  if (amount <= 0n) throw new BillingRequestError("amountUsd must be positive");
  return amount;
}

function isFreeTierLot(lot: CreditLotView): boolean {
  return lot.source === "grant" && (lot.grantReason ?? "").startsWith("free_tier_");
}

function includedLot(lots: CreditLotView[]): CreditLotView | null {
  const unexpired = lots.filter((lot) => isUnexpired(lot));
  return (
    unexpired.find((lot) => lot.source === "subscription") ?? unexpired.find(isFreeTierLot) ?? null
  );
}

function debtMagnitude(lots: CreditLotView[]): bigint {
  return lots.reduce((sum, lot) => {
    if (lot.source !== "debt") return sum;
    const balance = BigInt(lot.balanceMillicredits);
    return balance < 0n ? sum - balance : sum;
  }, 0n);
}

function includedUsagePercent(lot: CreditLotView | null, lots: CreditLotView[]): number | null {
  if (!lot) return null;
  const original = BigInt(lot.originalMillicredits);
  if (original <= 0n) return null;
  const used = original - BigInt(lot.balanceMillicredits) + debtMagnitude(lots);
  return Number((used * 10_000n) / original) / 100;
}

export async function billingBalance(
  deps: BillingRouteDeps,
  input: { userId: string },
): Promise<BillingBalanceResponse> {
  await deps.freeTier.ensure(input.userId);
  const breakdown = await deps.ledger.getBalanceBreakdown({ userId: input.userId });
  const displayLot = includedLot(breakdown.lots);
  const purchasedBalance = breakdown.lots.reduce((sum, lot) => {
    return lot.source === "purchase" ? sum + BigInt(lot.balanceMillicredits) : sum;
  }, 0n);
  const totalBalance = breakdown.lots.reduce(
    (sum, lot) => sum + BigInt(lot.balanceMillicredits),
    0n,
  );

  return {
    purchasedBalanceUsd: millicreditsToUsd(purchasedBalance),
    includedUsagePercent: includedUsagePercent(displayLot, breakdown.lots),
    usageMode:
      displayLot?.source === "subscription"
        ? "subscription"
        : displayLot && isFreeTierLot(displayLot)
          ? "free"
          : "none",
    canStartTurn: totalBalance > 0n,
  };
}

function billingTransaction(row: CreditTransactionRow): BillingTransaction {
  return {
    id: row.id,
    transactionType: row.transactionType,
    amountUsd: millicreditsToUsd(row.amountMillicredits),
    sourceType: row.sourceType,
    reason: row.reason,
    usageEventId: row.usageEventId,
    createdAt: row.createdAt,
    metadata: row.metadata,
  };
}

export async function billingTransactions(
  deps: BillingRouteDeps,
  input: { userId: string; limit?: number },
): Promise<BillingTransactionsResponse> {
  await deps.freeTier.ensure(input.userId);
  const transactions = await deps.ledger.listTransactions(input);
  const totalConsumed = transactions.reduce((sum, tx) => {
    const amount = BigInt(tx.amountMillicredits);
    return amount < 0n ? sum - amount : sum;
  }, 0n);
  return {
    transactions: transactions.map(billingTransaction),
    usage: {
      totalConsumedUsd: millicreditsToUsd(totalConsumed),
      transactionCount: transactions.length,
    },
  };
}

export function billingProducts(deps: BillingRouteDeps): BillingProductsResponse {
  return {
    entries: [...BILLING_PLANS, EXTRA_USAGE].map(publicCatalogEntry),
    stripeConfigured: deps.stripeGateway !== null,
  };
}

function stripePriceId(env: NodeJS.ProcessEnv, entry: BillingPlanCatalogEntry): string {
  const priceId = env[entry.stripePriceEnv];
  if (!priceId) throw new Error(`Stripe price env ${entry.stripePriceEnv} is not configured`);
  return priceId;
}

function extraUsageGrantMillicredits(body: CreateCheckoutSessionRequest): string {
  if (!body.amountUsd)
    throw new BillingRequestError("amountUsd is required for extra usage checkout");
  const amount = parseUsdToMillicredits(body.amountUsd);
  const min = parseUsdToMillicredits(EXTRA_USAGE.minUsd);
  const increment = parseUsdToMillicredits(EXTRA_USAGE.incrementUsd);
  if (amount < min)
    throw new BillingRequestError(`amountUsd must be at least ${EXTRA_USAGE.minUsd}`);
  if (amount % increment !== 0n) {
    throw new BillingRequestError(`amountUsd must be in ${EXTRA_USAGE.incrementUsd} increments`);
  }
  return ((amount * BigInt(EXTRA_USAGE.millicreditsPerUsd)) / 100_000n).toString();
}

function checkoutEntry(entry: BillingCatalogServerEntry, body: CreateCheckoutSessionRequest) {
  if (entry.kind === "extra-usage") {
    return {
      kind: "extra-usage" as const,
      grantMillicredits: extraUsageGrantMillicredits(body),
      catalogId: entry.id,
    };
  }
  return {
    kind: "plan" as const,
    grantMillicredits: entry.grantMillicredits,
    catalogId: entry.id,
    interval: entry.interval,
  };
}

export async function createBillingCheckoutSession(
  deps: BillingRouteDeps,
  input: { userId: string; body: CreateCheckoutSessionRequest },
): Promise<CreateCheckoutSessionResponse> {
  if (!deps.stripeGateway) throw new Error("Stripe checkout is not configured");
  const entry = catalogEntry(input.body.entryId);
  if (!entry) throw new BillingRequestError("Unknown billing entry");

  const customerId = await deps.getOrCreateStripeCustomer(input.userId);
  if (entry.kind === "plan") {
    const liveSubscription = await deps.stripeGateway.getLiveSubscription(customerId);
    if (liveSubscription) {
      const portal = await deps.stripeGateway.createPortalSession({
        customerId,
        returnUrl: input.body.cancelUrl,
      });
      return { kind: "portal", url: portal.url };
    }
  }

  const session = await deps.stripeGateway.createCheckoutSession({
    customerId,
    userId: input.userId,
    entry: checkoutEntry(entry, input.body),
    stripePriceId: entry.kind === "plan" ? stripePriceId(deps.env, entry) : null,
    successUrl: input.body.successUrl,
    cancelUrl: input.body.cancelUrl,
  });
  return { kind: "checkout", sessionId: session.id, url: session.url };
}

export async function handleBillingWebhook(
  deps: BillingRouteDeps,
  input: { payload: string; signature: string | null },
): Promise<BillingWebhookResponse> {
  if (!deps.stripeGateway) throw new Error("Stripe webhook is not configured");
  if (!input.signature) throw new Error("Stripe signature is required");
  const event = deps.stripeGateway.constructWebhookEvent({
    rawBody: input.payload,
    signature: input.signature,
  });
  const grant = await deps.stripeGateway.resolveCheckoutGrant(event);
  if (grant) await deps.ledger.grant(grant);
  return { received: true };
}
