/**
 * Pure monotonic-replacement policy for subscription upserts. Stripe lifecycle
 * webhooks (checkout / updated / deleted / invoice) arrive out of order, so the
 * rule for "does this event move the subscription forward, and which sibling
 * rows does it supersede" must be identical everywhere it runs. Centralising it
 * here keeps the drizzle store (SQL projection) and the in-memory store from
 * drifting into divergent — and previously Date-unsafe — copies.
 */
import type {
  SubscriptionRecord,
  SubscriptionStatus,
  SubscriptionUpsertInput,
} from "../ports/subscription-store.js";

/** Statuses that count as a live subscription — everything but a hard cancel. */
export const ACTIVE_SUBSCRIPTION_STATUSES = [
  "active",
  "past_due",
  "trialing",
] as const satisfies readonly SubscriptionStatus[];

export function isActiveStatus(status: SubscriptionStatus): boolean {
  return status !== "cancelled";
}

function periodStartMillis(value: string): number {
  return new Date(value).getTime();
}

/**
 * True when `input` may overwrite the existing row. A replacement is rejected
 * when it would rewind the billing period, or revive a cancelled period at the
 * same start (a late "active" replay must not un-cancel a deleted subscription).
 */
export function isMonotonicReplacement(
  existing: Pick<SubscriptionRecord, "currentPeriodStart" | "status">,
  input: Pick<SubscriptionUpsertInput, "currentPeriodStart" | "status">,
): boolean {
  const existingStart = periodStartMillis(existing.currentPeriodStart);
  const inputStart = periodStartMillis(input.currentPeriodStart);
  if (Number.isFinite(existingStart) && Number.isFinite(inputStart) && inputStart < existingStart) {
    return false;
  }
  return !(
    inputStart === existingStart &&
    existing.status === "cancelled" &&
    input.status !== "cancelled"
  );
}

export type SiblingDisposition = "blocks" | "cancel" | "ignore";

/**
 * Decide how an existing sibling subscription (a *different* Stripe id for the
 * same user) reacts to an incoming upsert: a still-active sibling whose period
 * starts strictly later already won the monotonic race and `blocks` the upsert;
 * an active sibling at or before the input's period is superseded and gets
 * `cancel`led; everything else is left untouched (`ignore`). A cancellation
 * never blocks or cancels siblings. Mirrors the drizzle store's SQL projection.
 */
export function classifyActiveSibling(
  sibling: Pick<
    SubscriptionRecord,
    "userId" | "stripeSubscriptionId" | "status" | "currentPeriodStart"
  >,
  input: Pick<
    SubscriptionUpsertInput,
    "userId" | "stripeSubscriptionId" | "status" | "currentPeriodStart"
  >,
): SiblingDisposition {
  if (
    sibling.userId !== input.userId ||
    sibling.stripeSubscriptionId === input.stripeSubscriptionId ||
    !isActiveStatus(sibling.status) ||
    input.status === "cancelled"
  ) {
    return "ignore";
  }
  const siblingStart = periodStartMillis(sibling.currentPeriodStart);
  const inputStart = periodStartMillis(input.currentPeriodStart);
  if (Number.isFinite(siblingStart) && Number.isFinite(inputStart) && siblingStart > inputStart) {
    return "blocks";
  }
  return "cancel";
}
