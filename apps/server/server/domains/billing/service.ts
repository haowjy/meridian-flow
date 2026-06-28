import type {
  BillingBalanceResponse,
  BillingProductsResponse,
  BillingTransaction,
  BillingTransactionsResponse,
  BillingWebhookResponse,
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResponse,
} from "@meridian/contracts/protocol";
import type { StripeBillingGateway } from "./adapters/stripe/stripe-gateway.js";
import {
  BILLING_PLANS,
  type BillingCatalogServerEntry,
  type BillingPlanCatalogEntry,
  billingPlanPriceBindings,
  catalogEntry,
  EXTRA_USAGE,
  publicCatalogEntry,
} from "./domain/catalog.js";
import type { CreditLedger, CreditLotView, CreditTransactionRow } from "./domain/credit-ledger.js";
import { BillingRequestError } from "./domain/errors.js";
import { ensureFreeTier } from "./domain/free-grants.js";
import { millicreditsToUsd, usdToMillicredits } from "./domain/money.js";
import { resolveStripeWebhookGrant } from "./domain/stripe-webhook-grants.js";
import { type BillingUsagePolicy, createBillingUsagePolicy } from "./domain/usage-policy.js";

export { BillingRequestError } from "./domain/errors.js";

export interface BillingServiceDeps {
  ledger: CreditLedger;
  stripeGateway: StripeBillingGateway | null;
  getOrCreateStripeCustomer: (userId: string) => Promise<string>;
  env: NodeJS.ProcessEnv;
}

function isUnexpired(lot: CreditLotView, now = new Date()): boolean {
  return lot.expiresAt === null || new Date(lot.expiresAt).getTime() > now.getTime();
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

function includedUsagePercent(lot: CreditLotView, lots: CreditLotView[]): number {
  const original = BigInt(lot.originalMillicredits);
  if (original <= 0n) return 0;
  const used = original - BigInt(lot.balanceMillicredits) + debtMagnitude(lots);
  return Number((used * 10_000n) / original) / 100;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function includedUsage(
  lot: CreditLotView | null,
  lots: CreditLotView[],
): BillingBalanceResponse["includedUsage"] {
  if (!lot) return { mode: "none" };
  const consumedPercent = includedUsagePercent(lot, lots);
  return {
    mode: lot.source === "subscription" ? "subscription" : "free",
    remainingPercent: clamp(round2(100 - consumedPercent), 0, 100),
    overBudget: consumedPercent > 100,
  };
}

async function billingBalance(
  deps: BillingServiceDeps,
  input: { userId: string },
): Promise<BillingBalanceResponse> {
  await ensureFreeTier(deps.ledger, input.userId);
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
    canStartTurn: totalBalance > 0n,
    includedUsage: includedUsage(displayLot, breakdown.lots),
  };
}

function transactionKind(row: CreditTransactionRow): BillingTransaction["kind"] {
  if (row.transactionType === "purchase") return "purchase";
  if (row.transactionType === "grant") return "grant";
  if (row.transactionType === "consumption") return "consumption";
  return "adjustment";
}

function transactionLabel(row: CreditTransactionRow): string {
  if (row.displayReason) return row.displayReason;
  if (row.transactionType === "consumption") return "Model usage";
  if (row.transactionType === "purchase") return "Extra usage";
  if (row.transactionType === "grant") return "Monthly usage";
  return "Billing adjustment";
}

function billingTransaction(row: CreditTransactionRow): BillingTransaction {
  return {
    id: row.id,
    kind: transactionKind(row),
    label: transactionLabel(row),
    amountUsd: millicreditsToUsd(row.amountMillicredits),
    createdAt: row.createdAt,
  };
}

async function billingTransactions(
  deps: BillingServiceDeps,
  input: { userId: string; limit?: number },
): Promise<BillingTransactionsResponse> {
  await ensureFreeTier(deps.ledger, input.userId);
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

function billingProducts(deps: BillingServiceDeps): BillingProductsResponse {
  const configuredPlanCount = billingPlanPriceBindings(deps.env).length;
  return {
    entries: [...BILLING_PLANS, EXTRA_USAGE].map(publicCatalogEntry),
    stripeConfigured: deps.stripeGateway !== null && configuredPlanCount === BILLING_PLANS.length,
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
  const amountMillicredits = usdToMillicredits(body.amountUsd);
  const minMillicredits = usdToMillicredits(EXTRA_USAGE.amountOptions.minUsd);
  const maxMillicredits = usdToMillicredits(EXTRA_USAGE.amountOptions.maxUsd);
  if (amountMillicredits < minMillicredits)
    throw new BillingRequestError(`amountUsd must be at least ${EXTRA_USAGE.amountOptions.minUsd}`);
  if (amountMillicredits > maxMillicredits)
    throw new BillingRequestError(`amountUsd must be at most ${EXTRA_USAGE.amountOptions.maxUsd}`);
  return amountMillicredits.toString();
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

async function createBillingCheckoutSession(
  deps: BillingServiceDeps,
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

async function handleBillingWebhook(
  deps: BillingServiceDeps,
  input: { payload: string; signature: string | null },
): Promise<BillingWebhookResponse> {
  if (!deps.stripeGateway) throw new Error("Stripe webhook is not configured");
  if (!input.signature) throw new Error("Stripe signature is required");
  const event = deps.stripeGateway.constructWebhookEvent({
    rawBody: input.payload,
    signature: input.signature,
  });
  const grant = resolveStripeWebhookGrant(event, {
    planPrices: billingPlanPriceBindings(deps.env),
  });
  if (grant) await deps.ledger.grant(grant);
  return { received: true };
}

export interface BillingService {
  readonly usage: BillingUsagePolicy;
  balance(input: { userId: string }): Promise<BillingBalanceResponse>;
  transactions(input: { userId: string; limit?: number }): Promise<BillingTransactionsResponse>;
  products(): BillingProductsResponse;
  createCheckoutSession(input: {
    userId: string;
    body: CreateCheckoutSessionRequest;
  }): Promise<CreateCheckoutSessionResponse>;
  handleWebhook(input: {
    payload: string;
    signature: string | null;
  }): Promise<BillingWebhookResponse>;
}

export function createBillingService(deps: BillingServiceDeps): BillingService {
  return {
    usage: createBillingUsagePolicy(deps.ledger),
    balance: (input) => billingBalance(deps, input),
    transactions: (input) => billingTransactions(deps, input),
    products: () => billingProducts(deps),
    createCheckoutSession: (input) => createBillingCheckoutSession(deps, input),
    handleWebhook: (input) => handleBillingWebhook(deps, input),
  };
}
