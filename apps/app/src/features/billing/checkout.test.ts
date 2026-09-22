/**
 * Checkout return reconciliation contract.
 *
 * Stripe owns payment truth and the server ledger owns balance/transactions.
 * These tests pin the client's ability to *prove* a returned success against a
 * same-tab baseline, and its refusal to over-claim when the ledger shows no
 * attributable delta.
 */
import type {
  BillingBalanceResponse,
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

const transactions = (
  transactions: BillingTransactionsResponse["transactions"],
): BillingTransactionsResponse => ({
  transactions,
  usage: { totalConsumedUsd: "0.00", transactionCount: transactions.length },
});

const purchase = {
  kind: "purchase" as const,
  label: "Extra usage",
  amountUsd: "10.00",
  createdAt: "2026-09-01T00:00:00.000Z",
};
const grant = {
  kind: "grant" as const,
  label: "Monthly usage",
  amountUsd: "5.00",
  createdAt: "2026-09-01T00:00:00.000Z",
};

const extraRequest: CreateCheckoutSessionRequest = {
  entryId: "extra",
  amountUsd: "10.00",
  successUrl: "https://app.test/billing?checkout=success",
  cancelUrl: "https://app.test/billing?checkout=cancelled",
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
  it("round-trips a captured baseline", () => {
    const baseline = checkoutBaselineFrom(balance("none"), transactions([]), extraRequest);
    expect(parseCheckoutBaseline(JSON.stringify(baseline))).toEqual(baseline);
  });

  it("rejects missing, malformed, and partial records", () => {
    expect(parseCheckoutBaseline(null)).toBeNull();
    expect(parseCheckoutBaseline("{")).toBeNull();
    expect(parseCheckoutBaseline(JSON.stringify({ entryId: "extra" }))).toBeNull();
  });
});

describe("isCheckoutConfirmed", () => {
  it("confirms extra usage only once a new purchase lands past the baseline", () => {
    const baseline = checkoutBaselineFrom(balance("none"), transactions([]), extraRequest);
    expect(isCheckoutConfirmed(baseline, balance("none"), transactions([]))).toBe(false);
    expect(isCheckoutConfirmed(baseline, balance("none"), transactions([purchase]))).toBe(true);
  });

  it("confirms a plan only on the transition into a subscription lot", () => {
    const planRequest = { ...extraRequest, entryId: "plan-a", amountUsd: undefined };
    const baseline = checkoutBaselineFrom(balance("free"), transactions([]), planRequest);
    expect(isCheckoutConfirmed(baseline, balance("free"), transactions([grant]))).toBe(false);
    expect(isCheckoutConfirmed(baseline, balance("subscription"), transactions([grant]))).toBe(
      true,
    );
  });

  it("does not confirm a renewal baseline that was already subscribed", () => {
    const planRequest = { ...extraRequest, entryId: "plan-a", amountUsd: undefined };
    const baseline = checkoutBaselineFrom(balance("subscription"), transactions([]), planRequest);
    expect(isCheckoutConfirmed(baseline, balance("subscription"), transactions([grant]))).toBe(
      false,
    );
  });
});
