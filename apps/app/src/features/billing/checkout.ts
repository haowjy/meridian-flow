/**
 * Checkout return reconciliation.
 *
 * Stripe owns payment truth and the server ledger (webhook-applied) owns
 * balance/transactions. The success URL carries no session id and there is no
 * session-status endpoint, so a returned `?checkout=success` is a claim, not
 * proof. The client confirms only when the authoritative ledger shows a delta
 * it can attribute to this checkout, measured against a same-tab baseline
 * captured when the session was created.
 *
 * The baseline is same-tab only. A missing or malformed baseline, or no delta
 * within the timeout budget, keeps the purchase unconfirmed and the UI honest.
 * Never project credits or a fabricated confirmation.
 */
import type {
  BillingBalanceResponse,
  BillingTransactionsResponse,
  CreateCheckoutSessionRequest,
} from "@meridian/contracts/protocol";

export const CHECKOUT_BASELINE_STORAGE_KEY = "meridian.billing.checkout-baseline";
/** Refetch cadence while waiting for the Stripe webhook to reach the ledger. */
export const CHECKOUT_RETURN_RECONCILE_INTERVAL_MS = 1_500;
/** How long a returned success stays "reconciling" before the honest timeout. */
export const CHECKOUT_RETURN_TIMEOUT_MS = 15_000;

export type CheckoutReturnStatus = "idle" | "cancelled" | "reconciling" | "confirmed" | "timeout";

type IncludedUsageMode = BillingBalanceResponse["includedUsage"]["mode"];

export interface CheckoutBaseline {
  entryId: string;
  /** Present for extra usage; identifies the purchase we expect. */
  amountUsd: string | null;
  purchaseCount: number;
  includedUsageMode: IncludedUsageMode;
}

function isIncludedUsageMode(value: unknown): value is IncludedUsageMode {
  return value === "none" || value === "subscription" || value === "free";
}

export function parseCheckoutReturn(search: string): "success" | "cancelled" | null {
  const value = new URLSearchParams(search).get("checkout");
  if (value === "success") return "success";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  return null;
}

export function checkoutBaselineFrom(
  balance: BillingBalanceResponse,
  transactions: BillingTransactionsResponse,
  request: CreateCheckoutSessionRequest,
): CheckoutBaseline {
  return {
    entryId: request.entryId,
    amountUsd: request.amountUsd ?? null,
    purchaseCount: transactions.transactions.filter((tx) => tx.kind === "purchase").length,
    includedUsageMode: balance.includedUsage.mode,
  };
}

export function parseCheckoutBaseline(raw: string | null): CheckoutBaseline | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CheckoutBaseline>;
    if (
      typeof parsed.entryId !== "string" ||
      (parsed.amountUsd !== null && typeof parsed.amountUsd !== "string") ||
      typeof parsed.purchaseCount !== "number" ||
      !isIncludedUsageMode(parsed.includedUsageMode)
    ) {
      return null;
    }
    return {
      entryId: parsed.entryId,
      amountUsd: parsed.amountUsd ?? null,
      purchaseCount: parsed.purchaseCount,
      includedUsageMode: parsed.includedUsageMode,
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

/** Drop the return marker so a later reload does not replay the notice. */
export function clearCheckoutReturnParam(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("checkout")) return;
  url.searchParams.delete("checkout");
  window.history.replaceState(window.history.state, "", url.toString());
}

/**
 * True only when the ledger shows a delta attributable to this checkout.
 *
 * Extra usage expects a new purchase-kind transaction. A plan expects the
 * transition into a subscription lot; a free-tier grant cannot produce that.
 */
export function isCheckoutConfirmed(
  baseline: CheckoutBaseline,
  balance: BillingBalanceResponse,
  transactions: BillingTransactionsResponse,
): boolean {
  if (baseline.amountUsd !== null) {
    const purchaseCount = transactions.transactions.filter((tx) => tx.kind === "purchase").length;
    return purchaseCount > baseline.purchaseCount;
  }
  return (
    balance.includedUsage.mode === "subscription" && baseline.includedUsageMode !== "subscription"
  );
}
