/**
 * Checkout return reconciliation.
 *
 * Stripe owns payment truth and the server ledger (webhook-applied) owns
 * balance/transactions. The success URL carries no session id and there is no
 * session-status endpoint, so a returned `?checkout=success` is a claim, not
 * proof. The client confirms only when the authoritative ledger shows a
 * transaction it can attribute to this checkout, measured against a same-tab
 * baseline captured from a *fresh* ledger read at handoff.
 *
 * Attribution uses a transaction fingerprint `(kind, createdAt, amountUsd)`:
 * - extra usage confirms only on a new `purchase` row whose amount matches the
 *   requested amount;
 * - a plan confirms only on a new `grant` row while the included usage is a
 *   subscription (a free-tier grant cannot satisfy both).
 *
 * The baseline is same-tab only. A missing or malformed baseline, or no
 * attributable delta within the timeout budget, keeps the purchase unconfirmed
 * and the UI honest. Never project credits or a fabricated confirmation.
 */
import type {
  BillingBalanceResponse,
  BillingTransaction,
  BillingTransactionsResponse,
  CreateCheckoutSessionRequest,
} from "@meridian/contracts/protocol";
import { equalsUsd } from "./amount";

export const CHECKOUT_BASELINE_STORAGE_KEY = "meridian.billing.checkout-baseline";
/** Refetch cadence while waiting for the Stripe webhook to reach the ledger. */
export const CHECKOUT_RETURN_RECONCILE_INTERVAL_MS = 1_500;
/** How long a returned success stays "reconciling" before the honest timeout. */
export const CHECKOUT_RETURN_TIMEOUT_MS = 15_000;

export type CheckoutReturnStatus =
  | "idle"
  | "cancelled"
  | "portal"
  | "reconciling"
  | "confirmed"
  | "timeout"
  | "unverified";

/**
 * How the page left for Stripe. A portal handoff reuses the checkout cancel
 * URL as its return URL, so the handoff kind is what lets the return notice
 * distinguish "you left checkout" from "you returned from the portal".
 */
export type CheckoutHandoffKind = "checkout" | "portal";

type IncludedUsageMode = BillingBalanceResponse["includedUsage"]["mode"];

export interface CheckoutBaseline {
  entryId: string;
  /** Present for extra usage; identifies the purchase we expect. */
  amountUsd: string | null;
  handoffKind: CheckoutHandoffKind;
  includedUsageMode: IncludedUsageMode;
  /** Fingerprints of every ledger row present at handoff. */
  transactionFingerprints: string[];
}

function isIncludedUsageMode(value: unknown): value is IncludedUsageMode {
  return value === "none" || value === "subscription" || value === "free";
}

function isHandoffKind(value: unknown): value is CheckoutHandoffKind {
  return value === "checkout" || value === "portal";
}

/** Stable identity for a ledger row across the capped transactions window. */
export function transactionFingerprint(transaction: BillingTransaction): string {
  return `${transaction.kind}|${transaction.createdAt}|${transaction.amountUsd}`;
}

export function parseCheckoutReturn(search: string): "success" | "cancelled" | null {
  const value = new URLSearchParams(search).get("checkout");
  if (value === "success") return "success";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  return null;
}

export function checkoutBaselineFrom(
  transactions: BillingTransaction[],
  request: CreateCheckoutSessionRequest,
  handoffKind: CheckoutHandoffKind,
  includedUsageMode: IncludedUsageMode = "none",
): CheckoutBaseline {
  return {
    entryId: request.entryId,
    amountUsd: request.amountUsd ?? null,
    handoffKind,
    includedUsageMode,
    transactionFingerprints: transactions.map(transactionFingerprint),
  };
}

export function parseCheckoutBaseline(raw: string | null): CheckoutBaseline | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CheckoutBaseline>;
    if (
      typeof parsed.entryId !== "string" ||
      (parsed.amountUsd !== null && typeof parsed.amountUsd !== "string") ||
      !isHandoffKind(parsed.handoffKind) ||
      !isIncludedUsageMode(parsed.includedUsageMode) ||
      !Array.isArray(parsed.transactionFingerprints) ||
      !parsed.transactionFingerprints.every((entry) => typeof entry === "string")
    ) {
      return null;
    }
    return {
      entryId: parsed.entryId,
      amountUsd: parsed.amountUsd ?? null,
      handoffKind: parsed.handoffKind,
      includedUsageMode: parsed.includedUsageMode,
      transactionFingerprints: parsed.transactionFingerprints,
    };
  } catch {
    return null;
  }
}

export function checkoutStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function readCheckoutBaseline(storage: Storage | null): CheckoutBaseline | null {
  return parseCheckoutBaseline(storage?.getItem(CHECKOUT_BASELINE_STORAGE_KEY) ?? null);
}

export function writeCheckoutBaseline(storage: Storage | null, baseline: CheckoutBaseline): void {
  storage?.setItem(CHECKOUT_BASELINE_STORAGE_KEY, JSON.stringify(baseline));
}

export function clearCheckoutBaseline(storage: Storage | null): void {
  storage?.removeItem(CHECKOUT_BASELINE_STORAGE_KEY);
}

/**
 * True only when the ledger shows a row attributable to this checkout.
 *
 * Extra usage expects a new `purchase` row with the requested amount. A plan
 * expects a new `grant` row while the balance reports a subscription lot. A
 * row whose fingerprint was already present at handoff is never "new", so a
 * pre-existing purchase or grant cannot fake a confirmation.
 */
export function isCheckoutConfirmed(
  baseline: CheckoutBaseline,
  balance: BillingBalanceResponse,
  transactions: BillingTransactionsResponse,
): boolean {
  const known = new Set(baseline.transactionFingerprints);
  const isNew = (transaction: BillingTransaction) =>
    !known.has(transactionFingerprint(transaction));

  const { amountUsd } = baseline;
  if (amountUsd !== null) {
    return transactions.transactions.some(
      (transaction) =>
        transaction.kind === "purchase" &&
        equalsUsd(transaction.amountUsd, amountUsd) &&
        isNew(transaction),
    );
  }

  return (
    balance.includedUsage.mode === "subscription" &&
    transactions.transactions.some(
      (transaction) => transaction.kind === "grant" && isNew(transaction),
    )
  );
}
