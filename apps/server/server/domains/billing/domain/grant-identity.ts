/** Canonical grant identity and display-label rules shared by credit ledger adapters. */
import type { CreditGrantInput, CreditGrantSource, CreditLotView } from "./credit-ledger.js";

export type GrantLotSource = Extract<
  CreditLotView["source"],
  "grant" | "purchase" | "subscription"
>;

export interface GrantIdentity {
  sourceType: GrantLotSource;
  grantReason: string | null;
  stripeSessionId: string | null;
}

export function lotSourceForGrant(source: CreditGrantSource): GrantLotSource {
  if (source === "stripe") return "purchase";
  if (source === "subscription") return "subscription";
  return "grant";
}

export function grantIdentity(input: CreditGrantInput): GrantIdentity {
  const sourceType = lotSourceForGrant(input.source);
  return {
    sourceType,
    grantReason:
      sourceType === "purchase" ? null : (input.stripeIdempotencyId ?? input.reason ?? null),
    stripeSessionId:
      sourceType === "purchase"
        ? (input.stripeSessionId ?? input.stripeIdempotencyId ?? null)
        : (input.stripeSessionId ?? null),
  };
}

export function isFreeTierGrantReason(reason: string | null): boolean {
  return reason?.startsWith("free_tier_") ?? false;
}

export function displayReasonFor(input: {
  displayReason?: string | null;
  sourceType: string | null;
  grantReason: string | null;
}): string | null {
  if (input.displayReason && input.displayReason.length > 0) return input.displayReason;
  if (isFreeTierGrantReason(input.grantReason)) return "Monthly usage";
  if (input.sourceType === "purchase") return "Extra usage";
  if (input.sourceType === "subscription") return "Monthly usage";
  return null;
}
