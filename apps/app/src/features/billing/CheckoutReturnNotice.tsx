import { Trans } from "@lingui/react/macro";
import { CheckCircle2, CircleAlert, Info, LoaderCircle } from "lucide-react";

import type { CheckoutReturnStatus } from "./checkout";

/**
 * Honest status for a Stripe redirect back to billing.
 *
 * The live region is mounted for the whole page life and its text changes in
 * place, so a status that appears after the return is announced. Success never
 * appears from Stripe's redirect alone; `useCheckoutReturn` only advances to
 * `confirmed` after the ledger shows an attributable delta. Everything else is
 * reconciled, unverified, or acknowledged plainly.
 */
export function CheckoutReturnNotice({ status }: { status: CheckoutReturnStatus }) {
  const visible = status !== "idle";

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={
        visible
          ? "flex items-start gap-3 rounded-lg border border-border-subtle bg-muted px-4 py-3 text-sm text-foreground"
          : "sr-only"
      }
    >
      {visible ? (
        <>
          <NoticeIcon status={status} />
          <p className="min-w-0 flex-1">
            <NoticeMessage status={status} />
          </p>
        </>
      ) : null}
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
  if (status === "timeout" || status === "unverified") {
    return <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />;
  }
  return <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />;
}

function NoticeMessage({ status }: { status: CheckoutReturnStatus }) {
  if (status === "reconciling") {
    return <Trans>Confirming your purchase…</Trans>;
  }
  if (status === "confirmed") {
    return <Trans>Purchase confirmed.</Trans>;
  }
  if (status === "timeout") {
    return (
      <Trans>We couldn’t confirm this purchase yet. Check your balance before trying again.</Trans>
    );
  }
  if (status === "unverified") {
    return (
      <Trans>We couldn’t confirm this purchase. Check your balance before trying again.</Trans>
    );
  }
  if (status === "portal") {
    return <Trans>Returned from the billing portal.</Trans>;
  }
  return <Trans>You left checkout. No purchase was confirmed.</Trans>;
}
