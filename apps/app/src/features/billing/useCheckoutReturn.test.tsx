// @vitest-environment jsdom
/**
 * Return-reconciliation contract for `?checkout=success` / `?checkout=cancelled`.
 *
 * The page never shows a confirmed purchase from Stripe's redirect alone: it
 * confirms only after the authoritative ledger shows an attributable delta
 * against the same-tab baseline, and otherwise reports an honest outcome. A
 * portal handoff is distinguished from a checkout cancellation.
 */
import type {
  BillingBalanceResponse,
  BillingTransactionsResponse,
} from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECKOUT_BASELINE_STORAGE_KEY,
  type CheckoutBaseline,
  readCheckoutBaseline,
} from "./checkout";
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
  handoffKind: "checkout",
  includedUsageMode: "none",
  transactionFingerprints: [],
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
      amountUsd: "10",
      createdAt: "2026-09-02T00:00:00.000Z",
    },
  ],
  usage: { totalConsumedUsd: "0.00", transactionCount: 1 },
};

/** Mimic the router navigation the page uses to drop the marker. */
function clearReturnParam() {
  window.history.replaceState({}, "", "/billing");
}

function Probe() {
  const status = useCheckoutReturn({
    intervalMs: 10,
    timeoutMs: 80,
    clearReturnParam,
  });
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
  refetches.transactions.mockResolvedValue({ data: noTransactions });
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
  it("times out honestly when no attributable delta ever lands", async () => {
    window.history.replaceState({}, "", "/billing?checkout=success");
    window.sessionStorage.setItem(CHECKOUT_BASELINE_STORAGE_KEY, JSON.stringify(baseline));

    await act(async () => root.render(<Probe />));
    expect(status()).toBe("reconciling");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });

    expect(status()).toBe("timeout");
    expect(window.sessionStorage.getItem(CHECKOUT_BASELINE_STORAGE_KEY)).toBeNull();
    expect(window.location.search).not.toContain("checkout=");
  });

  it("fails closed to unverified when the baseline is missing", async () => {
    window.history.replaceState({}, "", "/billing?checkout=success");
    refetches.transactions.mockResolvedValue({ data: withPurchase });

    await act(async () => root.render(<Probe />));

    expect(status()).toBe("unverified");
    expect(refetches.balance).not.toHaveBeenCalled();
    expect(refetches.transactions).not.toHaveBeenCalled();
    expect(window.location.search).not.toContain("checkout=");
  });

  it("does not treat a portal baseline on a success URL as purchase evidence", async () => {
    window.history.replaceState({}, "", "/billing?checkout=success");
    window.sessionStorage.setItem(
      CHECKOUT_BASELINE_STORAGE_KEY,
      JSON.stringify({ ...baseline, handoffKind: "portal" }),
    );
    refetches.transactions.mockResolvedValue({ data: withPurchase });

    await act(async () => root.render(<Probe />));

    expect(status()).toBe("unverified");
    expect(refetches.balance).not.toHaveBeenCalled();
    expect(refetches.transactions).not.toHaveBeenCalled();
    expect(readCheckoutBaseline(window.sessionStorage)).toBeNull();
  });

  it("resumes reconciliation after a reload mid-poll", async () => {
    window.history.replaceState({}, "", "/billing?checkout=success");
    window.sessionStorage.setItem(CHECKOUT_BASELINE_STORAGE_KEY, JSON.stringify(baseline));

    await act(async () => root.render(<Probe />));
    expect(status()).toBe("reconciling");

    // A reload keeps the marker and baseline: unmount the first page.
    await act(async () => root.unmount());
    root = createRoot(host);

    // The ledger is still behind; the reloaded page keeps reconciling.
    let call = 0;
    refetches.transactions.mockImplementation(async () => {
      call += 1;
      return { data: call >= 2 ? withPurchase : noTransactions };
    });
    await act(async () => root.render(<Probe />));

    expect(status()).toBe("reconciling");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(status()).toBe("confirmed");
  });

  it("reports cancellation without reconciling and without a charge claim", async () => {
    window.history.replaceState({}, "", "/billing?checkout=cancelled");
    window.sessionStorage.setItem(CHECKOUT_BASELINE_STORAGE_KEY, JSON.stringify(baseline));

    await act(async () => root.render(<Probe />));

    expect(status()).toBe("cancelled");
    expect(refetches.balance).not.toHaveBeenCalled();
    expect(readCheckoutBaseline(window.sessionStorage)).toBeNull();
    expect(window.location.search).not.toContain("checkout=");
  });

  it("reports a portal return distinctly from a checkout cancellation", async () => {
    window.history.replaceState({}, "", "/billing?checkout=cancelled");
    window.sessionStorage.setItem(
      CHECKOUT_BASELINE_STORAGE_KEY,
      JSON.stringify({ ...baseline, handoffKind: "portal" }),
    );

    await act(async () => root.render(<Probe />));

    expect(status()).toBe("portal");
    expect(refetches.balance).not.toHaveBeenCalled();
    expect(window.location.search).not.toContain("checkout=");
  });
});
