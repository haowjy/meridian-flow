import type {
  BillingBalanceResponse,
  BillingTransaction,
  BillingTransactionsResponse,
  CreateCheckoutSessionRequest,
} from "@meridian/contracts/protocol";
import { equalsUsd } from "./amount";

export const CHECKOUT_BASELINE_STORAGE_KEY = "meridian.billing.checkout-baseline";
export const CHECKOUT_RETURN_RECONCILE_INTERVAL_MS = 1_500;
export const CHECKOUT_RETURN_TIMEOUT_MS = 15_000;

export type CheckoutReturnStatus = "idle" | "reconciling" | "confirmed" | "timeout" | "unverified";

export type CheckoutHandoffKind = "checkout" | "portal";

type IncludedUsageMode = BillingBalanceResponse["includedUsage"]["mode"];

export interface CheckoutBaseline {
  entryId: string;
  amountUsd: string | null;
  handoffKind: CheckoutHandoffKind;
  includedUsageMode: IncludedUsageMode;
  transactionFingerprints: string[];
}

function isIncludedUsageMode(value: unknown): value is IncludedUsageMode {
  return value === "none" || value === "subscription" || value === "free";
}

function isHandoffKind(value: unknown): value is CheckoutHandoffKind {
  return value === "checkout" || value === "portal";
}

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
