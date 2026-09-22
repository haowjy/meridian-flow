// @vitest-environment jsdom
/**
 * Return-reconciliation contract for `?checkout=success`.
 *
 * The page never shows a confirmed purchase from Stripe's redirect alone: it
 * confirms only after the authoritative ledger shows an attributable delta
 * against the same-tab baseline, and otherwise reports an honest timeout.
 */
import type {
  BillingBalanceResponse,
  BillingTransactionsResponse,
} from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKOUT_BASELINE_STORAGE_KEY, type CheckoutBaseline } from "./checkout";
import { useCheckoutReturn } from "./useCheckoutReturn";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const refetches = vi.hoisted(() => ({
  balance: vi.fn(),
  transactions: vi.fn(),
}));

vi.mock("@/client/query/useBilling", () => ({
  useBillingBalance: () => ({ refetch: refetches.balance }),
  useBillingTransactions: () => ({ refetch: refetches.transactions }),
}));

const baseline: CheckoutBaseline = {
  entryId: "extra",
  amountUsd: "10.00",
  purchaseCount: 0,
  includedUsageMode: "none",
};

const balance: BillingBalanceResponse = {
  purchasedBalanceUsd: "0.00",
  canStartTurn: true,
  includedUsage: { mode: "none" },
};

const noTransactions: BillingTransactionsResponse = {
  transactions: [],
  usage: { totalConsumedUsd: "0.00", transactionCount: 0 },
};

const withPurchase: BillingTransactionsResponse = {
  transactions: [
    {
      kind: "purchase",
      label: "Extra usage",
      amountUsd: "10.00",
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  ],
  usage: { totalConsumedUsd: "0.00", transactionCount: 1 },
};

function Probe() {
  const status = useCheckoutReturn({ intervalMs: 10, timeoutMs: 80 });
  return <span data-status>{status}</span>;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState({}, "", "/billing");
  window.sessionStorage.clear();
  refetches.balance.mockReset();
  refetches.transactions.mockReset();
  refetches.balance.mockResolvedValue({ data: balance });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const status = () => host.querySelector("[data-status]")?.textContent;

describe("useCheckoutReturn", () => {
  it("stays idle on a normal billing visit", async () => {
    refetches.transactions.mockResolvedValue({ data: noTransactions });
    await act(async () => root.render(<Probe />));
    expect(status()).toBe("idle");
    expect(refetches.balance).not.toHaveBeenCalled();
  });

  it("waits for a delayed ledger delta before confirming", async () => {
    window.history.replaceState({}, "", "/billing?checkout=success");
    window.sessionStorage.setItem(CHECKOUT_BASELINE_STORAGE_KEY, JSON.stringify(baseline));
    let call = 0;
    refetches.transactions.mockImplementation(async () => {
      call += 1;
      return { data: call >= 3 ? withPurchase : noTransactions };
    });

    await act(async () => root.render(<Probe />));
    expect(status()).toBe("reconciling");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(status()).toBe("confirmed");
    expect(window.sessionStorage.getItem(CHECKOUT_BASELINE_STORAGE_KEY)).toBeNull();
    expect(window.location.search).not.toContain("checkout=");
  });

  it("times out honestly when no attributable delta ever lands", async () => {
    window.history.replaceState({}, "", "/billing?checkout=success");
    window.sessionStorage.setItem(CHECKOUT_BASELINE_STORAGE_KEY, JSON.stringify(baseline));
    refetches.transactions.mockResolvedValue({ data: noTransactions });

    await act(async () => root.render(<Probe />));
    expect(status()).toBe("reconciling");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });

    expect(status()).toBe("timeout");
    expect(window.sessionStorage.getItem(CHECKOUT_BASELINE_STORAGE_KEY)).toBeNull();
  });

  it("does not confirm when the baseline is missing", async () => {
    window.history.replaceState({}, "", "/billing?checkout=success");
    refetches.transactions.mockResolvedValue({ data: withPurchase });

    await act(async () => root.render(<Probe />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });

    expect(status()).toBe("timeout");
  });

  it("reports cancellation without reconciling", async () => {
    window.history.replaceState({}, "", "/billing?checkout=cancelled");
    await act(async () => root.render(<Probe />));

    expect(status()).toBe("cancelled");
    expect(refetches.balance).not.toHaveBeenCalled();
    expect(window.location.search).not.toContain("checkout=");
  });
});
