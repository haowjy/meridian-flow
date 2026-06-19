/**
 * CreditBalanceCard — the single credit-balance presentation, shared by the
 * settings Usage section and the standalone /billing page. Owns the balance
 * query and the millicredit formatting so callers just drop the card in.
 *
 * - `compact`: bordered summary box (label + balance), shown in the settings
 *   Usage section. No usage bar; renders "Loading…" until the balance resolves.
 * - `full`: the /billing hero card with the included-usage progress bar; shows
 *   "—" while the balance is loading.
 */
import { Trans } from "@lingui/react/macro";

import { useBillingBalance } from "@/client/query/useBilling";
import { creditsFromMillicredits } from "./format";

export type CreditBalanceCardVariant = "compact" | "full";

export function CreditBalanceCard({ variant }: { variant: CreditBalanceCardVariant }) {
  const balance = useBillingBalance();
  const credits = balance.data
    ? creditsFromMillicredits(balance.data.totalBalanceMillicredits)
    : null;

  if (variant === "compact") {
    return (
      <div className="rounded-lg border border-border-subtle bg-surface-subtle px-4 py-3">
        <span className="block text-sm text-muted-foreground">
          <Trans>Current balance</Trans>
        </span>
        <span className="mt-1 block text-xl font-semibold text-foreground">
          {credits !== null ? (
            <>
              {credits}{" "}
              <span className="text-sm font-normal text-muted-foreground">
                <Trans>credits</Trans>
              </span>
            </>
          ) : (
            <Trans>Loading…</Trans>
          )}
        </span>
      </div>
    );
  }

  const usagePercent = balance.data?.includedUsagePercent ?? 0;
  return (
    <div className="surface-card p-5">
      <p className="text-sm text-muted-foreground">
        <Trans>Current balance</Trans>
      </p>
      <div className="mt-2 text-4xl font-semibold tracking-tight">
        {credits ?? "—"}
        <span className="ml-2 text-base font-normal text-muted-foreground">
          <Trans>credits</Trans>
        </span>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${Math.min(usagePercent, 100)}%` }}
        />
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        <Trans>Included usage: {usagePercent}% used.</Trans>
      </p>
    </div>
  );
}
