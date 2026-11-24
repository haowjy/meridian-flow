import { Trans } from "@lingui/react/macro";
import { CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";

import type { CheckoutReturnStatus } from "./checkout";

export function CheckoutReturnNotice({ status }: { status: CheckoutReturnStatus }) {
  const visible = status !== "idle";

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={
        visible
          ? "flex items-start gap-3 rounded-lg border border-border-subtle bg-ink-fill px-4 py-3 text-sm text-foreground"
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
  return <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />;
}

function NoticeMessage({ status }: { status: CheckoutReturnStatus }) {
  if (status === "reconciling") {
    return <Trans>Confirming your purchase…</Trans>;
  }
  if (status === "confirmed") {
    return <Trans>Purchase confirmed</Trans>;
  }
  return <Trans>Purchase not confirmed</Trans>;
}
