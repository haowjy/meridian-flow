/**
 * Checkout return reconciliation contract.
 *
 * Stripe owns payment truth and the server ledger owns balance/transactions.
 * These tests pin the client's ability to *prove* a returned success against a
 * same-tab baseline captured from a fresh read, and its refusal to over-claim
 * when the ledger shows no attributable delta.
 */
import type {
  BillingBalanceResponse,
  BillingTransaction,
  BillingTransactionsResponse,
  CreateCheckoutSessionRequest,
} from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import {
  checkoutBaselineFrom,
  isCheckoutConfirmed,
  parseCheckoutBaseline,
  parseCheckoutReturn,
} from "./checkout";

const balance = (
  mode: BillingBalanceResponse["includedUsage"]["mode"],
): BillingBalanceResponse => ({
  purchasedBalanceUsd: "0.00",
  canStartTurn: true,
  includedUsage: mode === "none" ? { mode } : { mode, remainingPercent: 100, overBudget: false },
});

const transactions = (rows: BillingTransaction[]): BillingTransactionsResponse => ({
  transactions: rows,
  usage: { totalConsumedUsd: "0.00", transactionCount: rows.length },
});

const purchase = (
  amountUsd: string,
  createdAt = "2026-09-02T00:00:00.000Z",
): BillingTransaction => ({
  kind: "purchase",
  label: "Extra usage",
  amountUsd,
  createdAt,
});

const existingPurchase = purchase("10", "2026-09-01T00:00:00.000Z");
const grant = (createdAt = "2026-09-02T00:00:00.000Z"): BillingTransaction => ({
  kind: "grant",
  label: "Monthly usage",
  amountUsd: "5",
  createdAt,
});

const extraRequest: CreateCheckoutSessionRequest = {
  entryId: "extra",
  amountUsd: "10.00",
  successUrl: "https://app.test/billing?checkout=success",
  cancelUrl: "https://app.test/billing?checkout=cancelled",
};

const planRequest: CreateCheckoutSessionRequest = {
  ...extraRequest,
  entryId: "plan-a",
  amountUsd: undefined,
};

describe("parseCheckoutReturn", () => {
  it("reads success and both cancellation spellings", () => {
    expect(parseCheckoutReturn("?checkout=success")).toBe("success");
    expect(parseCheckoutReturn("?checkout=cancelled")).toBe("cancelled");
    expect(parseCheckoutReturn("?checkout=canceled")).toBe("cancelled");
  });

  it("ignores unrelated or missing params", () => {
    expect(parseCheckoutReturn("")).toBeNull();
    expect(parseCheckoutReturn("?settings=usage")).toBeNull();
  });
});

describe("parseCheckoutBaseline", () => {
  it("round-trips a captured checkout baseline", () => {
    const baseline = checkoutBaselineFrom([existingPurchase], extraRequest, "checkout", "none");
    expect(parseCheckoutBaseline(JSON.stringify(baseline))).toEqual(baseline);
  });

  it("round-trips a portal handoff that carries no ledger rows", () => {
    const baseline = checkoutBaselineFrom([], planRequest, "portal");
    expect(parseCheckoutBaseline(JSON.stringify(baseline))).toEqual(baseline);
  });

  it("rejects missing, malformed, and partial records", () => {
    expect(parseCheckoutBaseline(null)).toBeNull();
    expect(parseCheckoutBaseline("{")).toBeNull();
    expect(parseCheckoutBaseline(JSON.stringify({ entryId: "extra" }))).toBeNull();
    expect(
      parseCheckoutBaseline(
        JSON.stringify({
          entryId: "extra",
          amountUsd: null,
          handoffKind: "checkout",
          includedUsageMode: "none",
          transactionFingerprints: [1],
        }),
      ),
    ).toBeNull();
  });
});

describe("isCheckoutConfirmed", () => {
  it("confirms extra usage on a new purchase with the requested amount", () => {
    const baseline = checkoutBaselineFrom([], extraRequest, "checkout", "none");
    expect(isCheckoutConfirmed(baseline, balance("none"), transactions([]))).toBe(false);
    expect(isCheckoutConfirmed(baseline, balance("none"), transactions([purchase("10")]))).toBe(
      true,
    );
  });

  it("does not confirm a purchase whose amount differs from the request", () => {
    const baseline = checkoutBaselineFrom([], extraRequest, "checkout", "none");
    expect(isCheckoutConfirmed(baseline, balance("none"), transactions([purchase("25.00")]))).toBe(
      false,
    );
  });

  it("does not confirm a pre-existing purchase already in the baseline", () => {
    // The fresh baseline captures every row on the server, so a purchase that
    // predates this checkout is never a "new" delta.
    const baseline = checkoutBaselineFrom([existingPurchase], extraRequest, "checkout", "none");
    expect(isCheckoutConfirmed(baseline, balance("none"), transactions([existingPurchase]))).toBe(
      false,
    );
  });

  it("does not confirm extra usage from a new grant", () => {
    const baseline = checkoutBaselineFrom([], extraRequest, "checkout", "none");
    expect(isCheckoutConfirmed(baseline, balance("subscription"), transactions([grant()]))).toBe(
      false,
    );
  });

  it("confirms a plan on a new grant while included usage is a subscription", () => {
    const baseline = checkoutBaselineFrom([], planRequest, "checkout", "free");
    expect(isCheckoutConfirmed(baseline, balance("free"), transactions([grant()]))).toBe(false);
    expect(isCheckoutConfirmed(baseline, balance("subscription"), transactions([grant()]))).toBe(
      true,
    );
  });

  it("confirms a plan even when the baseline was already subscribed", () => {
    // A cancelled-but-unexpired Stripe subscription leaves the ledger in
    // `subscription` mode. The new grant is still proof this checkout paid.
    const baseline = checkoutBaselineFrom([], planRequest, "checkout", "subscription");
    const freshGrant = grant();
    expect(isCheckoutConfirmed(baseline, balance("subscription"), transactions([freshGrant]))).toBe(
      true,
    );
  });

  it("does not confirm a plan from a grant already present at handoff", () => {
    const oldGrant = grant("2026-09-01T00:00:00.000Z");
    const baseline = checkoutBaselineFrom([oldGrant], planRequest, "checkout", "subscription");
    expect(isCheckoutConfirmed(baseline, balance("subscription"), transactions([oldGrant]))).toBe(
      false,
    );
  });

  it("does not confirm a plan when the fresh balance is not a subscription", () => {
    const baseline = checkoutBaselineFrom([], planRequest, "checkout", "free");
    expect(isCheckoutConfirmed(baseline, balance("free"), transactions([grant()]))).toBe(false);
  });
});
