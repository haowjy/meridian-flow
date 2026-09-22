import { useEffect, useRef, useState } from "react";

import { useBillingBalance, useBillingTransactions } from "@/client/query/useBilling";
import {
  CHECKOUT_RETURN_RECONCILE_INTERVAL_MS,
  CHECKOUT_RETURN_TIMEOUT_MS,
  type CheckoutReturnStatus,
  checkoutStorage,
  clearCheckoutBaseline,
  clearCheckoutReturnParam,
  isCheckoutConfirmed,
  parseCheckoutReturn,
  readCheckoutBaseline,
} from "./checkout";

export interface UseCheckoutReturnOptions {
  /** Override the refetch cadence (tests). */
  intervalMs?: number;
  /** Override the reconciling budget before the honest timeout (tests). */
  timeoutMs?: number;
}

/**
 * Reconciles a Stripe redirect back to billing.
 *
 * Reads the `?checkout=` marker after mount (SSR returns idle), then, for a
 * success, polls the existing balance/transactions queries until the ledger
 * shows an attributable delta or the budget runs out. The URL marker is cleared
 * once handled so a reload does not replay the notice.
 */
export function useCheckoutReturn(options: UseCheckoutReturnOptions = {}): CheckoutReturnStatus {
  const [status, setStatus] = useState<CheckoutReturnStatus>("idle");
  const { refetch: refetchBalance } = useBillingBalance();
  const { refetch: refetchTransactions } = useBillingTransactions();
  const refetchRef = useRef({ refetchBalance, refetchTransactions });
  refetchRef.current = { refetchBalance, refetchTransactions };

  const intervalMs = options.intervalMs ?? CHECKOUT_RETURN_RECONCILE_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? CHECKOUT_RETURN_TIMEOUT_MS;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const parsed = parseCheckoutReturn(window.location.search);
    if (parsed === "cancelled") {
      clearCheckoutReturnParam();
      setStatus("cancelled");
    } else if (parsed === "success") {
      setStatus("reconciling");
    }
  }, []);

  useEffect(() => {
    if (status !== "reconciling" || typeof window === "undefined") return;

    const storage = checkoutStorage();
    const baseline = readCheckoutBaseline(storage);
    clearCheckoutReturnParam();
    if (!baseline) {
      clearCheckoutBaseline(storage);
      setStatus("timeout");
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + timeoutMs;

    const tick = async () => {
      const [balanceResult, transactionsResult] = await Promise.all([
        refetchRef.current.refetchBalance(),
        refetchRef.current.refetchTransactions(),
      ]);
      if (cancelled) return;
      if (
        balanceResult.data &&
        transactionsResult.data &&
        isCheckoutConfirmed(baseline, balanceResult.data, transactionsResult.data)
      ) {
        clearCheckoutBaseline(storage);
        setStatus("confirmed");
        return;
      }
      if (Date.now() >= deadline) {
        clearCheckoutBaseline(storage);
        setStatus("timeout");
        return;
      }
      timer = setTimeout(() => void tick(), intervalMs);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [status, intervalMs, timeoutMs]);

  return status;
}
