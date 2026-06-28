/**
 * UsageCard — single source for the user's usage + balance presentation,
 * shared by the settings Usage section and the standalone /billing page.
 *
 * Three states driven by `usageMode` from the balance endpoint:
 *   - "subscription" / "free": progress bar of `includedUsagePercent`
 *     (bar width capped at 100%; the textual percent shows the real value so
 *     a go-negative grant reads as "105% of monthly usage consumed").
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
        <Trans>Usage</Trans>
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

  // `usageMode` is "subscription" or "free": progress bar + textual percent.
  // `includedUsagePercent` is non-null in these modes per the contract; the
  // `?? 0` is a defensive fallback that should not be reached.
  const percent = data.includedUsagePercent ?? 0;
  const barWidth = `${Math.min(Math.max(percent, 0), 100)}%`;
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
          {percent}%
        </span>
        <span className="text-sm text-muted-foreground">
          {data.usageMode === "subscription" ? (
            <Trans>of monthly usage consumed</Trans>
          ) : (
            <Trans>of free usage consumed</Trans>
          )}
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
        aria-valuenow={Math.min(Math.max(percent, 0), 100)}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
          style={{ width: barWidth }}
        />
      </div>
      {hasExtra ? (
        <p className="mt-2 text-sm text-muted-foreground">
          <Trans>{formatUsd(data.purchasedBalanceUsd)} additional balance</Trans>
        </p>
      ) : null}
    </div>
  );
}
