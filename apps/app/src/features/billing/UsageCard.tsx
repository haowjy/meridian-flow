/**
 * UsageCard — single source for the user's usage + balance presentation,
 * shared by the settings Usage section and the standalone /billing page.
 *
 * Three states driven by `usageMode` from the balance endpoint:
 *   - "subscription" / "free": fuel-gauge of monthly usage remaining. The
 *     server still emits `includedUsagePercent` as the consumed value (0..100+);
 *     the client derives `remaining = clamp(100 - consumed, 0, 100)` so a
 *     fresh user reads as "100% remaining" with a full bar that drains as
 *     usage accrues. Over-budget (consumed > 100) clamps to "0% remaining"
 *     with a muted "over your monthly usage" hint. Wording is neutral —
 *     "free" vs "subscription" is hidden because grant size is hidden too.
 *     If extra-usage balance is positive, it shows beneath the bar.
 *   - "none": no bar; only `purchasedBalanceUsd` as "$X.XX remaining".
 *     `includedUsagePercent` is null here — never coerce to 0.
 *
 * Variants:
 *   - `compact`: bordered summary used in the settings overlay.
 *   - `full`: hero card used on /billing.
 */
import { Trans } from "@lingui/react/macro";
import type { BillingBalanceResponse } from "@meridian/contracts/protocol";

import { useBillingBalance } from "@/client/query/useBilling";
import { formatUsd, isPositiveUsd } from "./format";

export type UsageCardVariant = "compact" | "full";

export function UsageCard({ variant }: { variant: UsageCardVariant }) {
  const balance = useBillingBalance();

  const shell =
    variant === "compact"
      ? "rounded-lg border border-border-subtle bg-surface-subtle px-4 py-3"
      : "surface-card p-5";

  return (
    <div className={shell}>
      <p className="text-sm text-muted-foreground">
        {variant === "full" ? <Trans>Monthly usage</Trans> : <Trans>Usage</Trans>}
      </p>
      {balance.data ? (
        <UsageBody data={balance.data} variant={variant} />
      ) : (
        <p
          className={
            variant === "full"
              ? "mt-3 text-base text-muted-foreground"
              : "mt-1 text-sm text-muted-foreground"
          }
        >
          <Trans>Loading…</Trans>
        </p>
      )}
    </div>
  );
}

function UsageBody({ data, variant }: { data: BillingBalanceResponse; variant: UsageCardVariant }) {
  if (data.usageMode === "none") {
    return (
      <div className={variant === "full" ? "mt-2" : "mt-1"}>
        <span
          className={
            variant === "full"
              ? "text-4xl font-semibold tracking-tight text-foreground"
              : "text-xl font-semibold text-foreground"
          }
        >
          {formatUsd(data.purchasedBalanceUsd)}
        </span>
        <span
          className={
            variant === "full"
              ? "ml-2 text-base font-normal text-muted-foreground"
              : "ml-2 text-sm font-normal text-muted-foreground"
          }
        >
          <Trans>remaining</Trans>
        </span>
      </div>
    );
  }

  // `usageMode` is "subscription" or "free": fuel-gauge of remaining usage.
  // Server emits `includedUsagePercent` as the CONSUMED value (0..100+); we
  // derive `remaining` here and present that. The `?? 0` is a defensive
  // fallback — the contract says non-null in these modes.
  const consumed = data.includedUsagePercent ?? 0;
  const remaining = Math.min(Math.max(100 - consumed, 0), 100);
  const barWidth = `${remaining}%`;
  const overBudget = consumed > 100;
  const hasExtra = isPositiveUsd(data.purchasedBalanceUsd);

  return (
    <div className={variant === "full" ? "mt-3" : "mt-2"}>
      <div className="flex items-baseline gap-2">
        <span
          className={
            variant === "full"
              ? "text-3xl font-semibold tracking-tight text-foreground"
              : "text-lg font-semibold text-foreground"
          }
        >
          <Trans>{remaining}% remaining</Trans>
        </span>
      </div>
      <div
        className={
          variant === "full"
            ? "mt-3 h-2 overflow-hidden rounded-full bg-muted"
            : "mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
        }
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
          style={{ width: barWidth }}
        />
      </div>
      {overBudget ? (
        <p className="mt-2 text-sm text-muted-foreground">
          <Trans>Over your monthly usage</Trans>
        </p>
      ) : null}
      {hasExtra ? (
        <p className="mt-2 text-sm text-muted-foreground">
          <Trans>{formatUsd(data.purchasedBalanceUsd)} additional balance</Trans>
        </p>
      ) : null}
    </div>
  );
}
