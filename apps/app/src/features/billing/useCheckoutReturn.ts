import { useEffect, useRef, useState } from "react";

import { useBillingBalance, useBillingTransactions } from "@/client/query/useBilling";
import {
  CHECKOUT_RETURN_RECONCILE_INTERVAL_MS,
  CHECKOUT_RETURN_TIMEOUT_MS,
  type CheckoutReturnStatus,
  checkoutStorage,
  clearCheckoutBaseline,
  isCheckoutConfirmed,
  parseCheckoutReturn,
  readCheckoutBaseline,
} from "./checkout";

export interface UseCheckoutReturnOptions {
  /** Override the refetch cadence (tests). */
  intervalMs?: number;
  /** Override the reconciling budget before the honest timeout (tests). */
  timeoutMs?: number;
  /**
   * Drop the `?checkout=` marker once the notice has settled. Callers pass a
   * router navigation so router state and the browser URL stay in sync; the
   * default is a no-op. The hook calls this only at a terminal status.
   */
  clearReturnParam?: () => void;
}

const noop = () => {};

/**
 * Reconciles a Stripe redirect back to billing.
 *
 * Reads the `?checkout=` marker after mount (SSR renders idle). A success with
 * a same-tab baseline polls the existing balance/transactions queries until the
 * ledger shows an attributable delta or the deadline fires. A success with no
 * baseline fails closed to `unverified` without polling: nothing can attribute
 * the return to this checkout. A portal handoff is distinguished from a
 * checkout cancellation by the recorded handoff kind. The marker and baseline
 * are cleared together, and only at a terminal status, so a reload mid-poll
 * resumes reconciliation.
 */
export function useCheckoutReturn(options: UseCheckoutReturnOptions = {}): CheckoutReturnStatus {
  const [status, setStatus] = useState<CheckoutReturnStatus>("idle");
  const { refetch: refetchBalance } = useBillingBalance();
  const { refetch: refetchTransactions } = useBillingTransactions();
  const refetchRef = useRef({ refetchBalance, refetchTransactions });
  refetchRef.current = { refetchBalance, refetchTransactions };

  const intervalMs = options.intervalMs ?? CHECKOUT_RETURN_RECONCILE_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? CHECKOUT_RETURN_TIMEOUT_MS;
  const clearReturnParam = options.clearReturnParam ?? noop;
  const clearRef = useRef(clearReturnParam);
  clearRef.current = clearReturnParam;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const parsed = parseCheckoutReturn(window.location.search);
    if (parsed === null) return;

    const storage = checkoutStorage();
    if (parsed === "cancelled") {
      const baseline = readCheckoutBaseline(storage);
      clearCheckoutBaseline(storage);
      setStatus(baseline?.handoffKind === "portal" ? "portal" : "cancelled");
      clearRef.current();
      return;
    }

    // A success with no baseline cannot be attributed to this checkout. Do not
    // poll and do not promise an update: fail closed and say so.
    if (!readCheckoutBaseline(storage)) {
      clearCheckoutBaseline(storage);
      setStatus("unverified");
      clearRef.current();
      return;
    }

    setStatus("reconciling");
  }, []);

  useEffect(() => {
    if (status !== "reconciling" || typeof window === "undefined") return;

    const storage = checkoutStorage();
    const baseline = readCheckoutBaseline(storage);
    if (!baseline) {
      clearCheckoutBaseline(storage);
      setStatus("unverified");
      clearRef.current();
      return;
    }

    let active = true;
    let intervalTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (next: CheckoutReturnStatus) => {
      if (!active) return;
      active = false;
      if (intervalTimer) clearTimeout(intervalTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      clearCheckoutBaseline(storage);
      setStatus(next);
      clearRef.current();
    };

    // Armed independently of the refetch loop so a hung balance/transactions
    // read cannot hold "Confirming…" up forever.
    deadlineTimer = setTimeout(() => settle("timeout"), timeoutMs);

    const tick = async () => {
      try {
        const [balanceResult, transactionsResult] = await Promise.all([
          refetchRef.current.refetchBalance(),
          refetchRef.current.refetchTransactions(),
        ]);
        if (!active) return;
        if (
          balanceResult.data &&
          transactionsResult.data &&
          isCheckoutConfirmed(baseline, balanceResult.data, transactionsResult.data)
        ) {
          settle("confirmed");
          return;
        }
      } catch {
        // A failed read proves nothing; keep waiting for the deadline.
      }
      if (!active) return;
      intervalTimer = setTimeout(() => void tick(), intervalMs);
    };

    void tick();
    return () => {
      active = false;
      if (intervalTimer) clearTimeout(intervalTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
    };
  }, [status, intervalMs, timeoutMs]);

  return status;
}
