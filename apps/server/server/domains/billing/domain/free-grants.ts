/** Free-tier grant helper for provisioning the monthly $0 plan lot. */
import { FREE_TIER } from "./catalog.js";
import type { CreditLedger } from "./credit-ledger.js";

export interface FreeTierClock {
  now(): Date;
}

export interface FreeTierConfig {
  clock?: FreeTierClock;
}

function periodStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function periodEnd(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function periodKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function ensureFreeTier(
  ledger: CreditLedger,
  userId: string,
  config: FreeTierConfig = {},
): Promise<void> {
  if (await ledger.hasUnexpiredLot({ userId, source: "subscription" })) return;

  if (await ledger.hasUnexpiredLot({ userId, source: "free" })) return;

  const now = config.clock?.now() ?? new Date();
  const start = periodStart(now);
  const idempotencyKey = `free_tier_${userId}_${periodKey(start)}`;

  await ledger.grant({
    userId,
    source: "free",
    amountMillicredits: FREE_TIER.grantMillicredits,
    reason: idempotencyKey,
    displayReason: "Monthly usage",
    expiresAt: periodEnd(now),
    stripeIdempotencyId: idempotencyKey,
    metadata: {
      grantKind: "free-tier",
      periodStart: start.toISOString(),
    },
  });
}
