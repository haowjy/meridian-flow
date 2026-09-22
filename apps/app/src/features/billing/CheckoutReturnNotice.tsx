import { Trans } from "@lingui/react/macro";
import { CheckCircle2, CircleAlert, Info, LoaderCircle } from "lucide-react";

import type { CheckoutReturnStatus } from "./checkout";

/**
 * Honest status for a Stripe redirect back to billing.
 *
 * Success never appears here from Stripe's redirect alone; `useCheckoutReturn`
 * only advances to `confirmed` after the ledger shows an attributable delta.
 * Everything else is reconciled or acknowledged plainly.
 */
export function CheckoutReturnNotice({ status }: { status: CheckoutReturnStatus }) {
  if (status === "idle") return null;

  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-lg border border-border-subtle bg-muted px-4 py-3 text-sm text-foreground"
    >
      <NoticeIcon status={status} />
      <p className="min-w-0 flex-1">
        <NoticeMessage status={status} />
      </p>
    </div>
  );
}

function NoticeIcon({ status }: { status: CheckoutReturnStatus }) {
  if (status === "reconciling") {
    return (
      <LoaderCircle
        className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground"
        aria-hidden
      />
    );
  }
  if (status === "confirmed") {
    return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />;
  }
  if (status === "timeout") {
    return <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />;
  }
  return <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />;
}

function NoticeMessage({ status }: { status: CheckoutReturnStatus }) {
  if (status === "reconciling") {
    return <Trans>Confirming your purchase…</Trans>;
  }
  if (status === "confirmed") {
    return <Trans>Purchase confirmed. Your balance has been updated.</Trans>;
  }
  if (status === "timeout") {
    return <Trans>We’re still confirming your purchase. Your balance will update shortly.</Trans>;
  }
  return <Trans>Checkout cancelled. Nothing was charged.</Trans>;
}
