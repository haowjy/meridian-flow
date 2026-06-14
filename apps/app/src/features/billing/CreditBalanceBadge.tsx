import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { Coins } from "lucide-react";
import { useBillingBalance } from "@/client/query/useBilling";
import { creditsFromMillicredits } from "./format";

export function CreditBalanceBadge() {
  const { data } = useBillingBalance();
  const balance = data ? creditsFromMillicredits(data.totalBalanceMillicredits) : "—";
  return (
    <Link
      to="/settings/billing"
      className="focus-ring flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
      aria-label="Billing settings"
    >
      <Coins className="size-4" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        <Trans>{balance} credits</Trans>
      </span>
    </Link>
  );
}
