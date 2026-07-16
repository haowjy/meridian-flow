/**
 * UsageCard — single source for the user's usage + balance presentation,
 * shared by the settings Usage section and the standalone /billing page.
 *
 * The balance endpoint sends display-ready included usage:
 *   - "subscription" / "free": monthly usage remaining plus an over-budget
 *     flag. Wording is neutral — "free" vs "subscription" is hidden because
 *     grant size is hidden too. If extra-usage balance is positive, it shows
 *     beneath the bar.
 *   - "none": no bar; only `purchasedBalanceUsd` as "$X.XX remaining".
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
      ? "rounded-lg border border-border-subtle bg-muted px-4 py-3"
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
  if (data.includedUsage.mode === "none") {
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

  const { remainingPercent, overBudget } = data.includedUsage;
  const barWidth = `${remainingPercent}%`;
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
          <Trans>{remainingPercent}% remaining</Trans>
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
        aria-valuenow={remainingPercent}
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
