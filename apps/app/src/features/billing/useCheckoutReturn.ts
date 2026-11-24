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
  intervalMs?: number;
  timeoutMs?: number;
  clearReturnParam?: () => void;
}

const noop = () => {};

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
      clearCheckoutBaseline(storage);
      setStatus("idle");
      clearRef.current();
      return;
    }

    const baseline = readCheckoutBaseline(storage);
    if (baseline?.handoffKind !== "checkout") {
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
    if (baseline?.handoffKind !== "checkout") {
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
