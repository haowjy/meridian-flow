/**
 * /billing — usage summary, catalog (subscription plans + extra usage), and
 * recent activity. The server emits USD strings + percentages; this page is
 * pure presentation over those values.
 *
 * Purchase actions go through Stripe Checkout / Customer Portal — the create
 * mutation returns a discriminated `{ kind: "checkout" | "portal", url }` and
 * the hook redirects. The server marks checkout availability per catalog entry
 * so one missing Stripe price does not disable unrelated purchases.
 *
 * Checkout is P0 server-confirmed: only the initiating control is pending, and
 * a failed session create shows an inline Retry on that control without locking
 * the rest of the catalog. A returned `?checkout=success` never confirms from
 * Stripe's redirect alone; `useCheckoutReturn` reconciles against the ledger.
 *
 * Plans have a fixed `priceUsd` + interval and a Subscribe button. Extra
 * usage has `amountOptions` instead — the user picks an amount via
 * `ExtraUsagePicker` and that value becomes `amountUsd` in the request.
 *
 * Layout: single calm centered column (max-w-2xl) — Usage hero → Plans
 * section → Extra usage section → Recent activity. Plans and extra-usage
 * sit in their own labeled sections (not crammed into one mixed grid).
 *
 * Scroll: the route mounts inside a bounded, non-flex, overflow-hidden
 * wrapper in `_authenticated.tsx`, so this page owns its own scroll with
 * `h-full overflow-y-auto`. Using `app-scroll` (which assumes a flex parent)
 * here would clip content with no scrollbar.
 */
import { Trans } from "@lingui/react/macro";
import type {
  BillingCatalogEntry,
  BillingPlanEntry,
  CreateCheckoutSessionRequest,
} from "@meridian/contracts/protocol";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import {
  useBillingProducts,
  useBillingTransactions,
  useCreateCheckoutSession,
} from "@/client/query/useBilling";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { CheckoutReturnNotice } from "./CheckoutReturnNotice";
import { ExtraUsagePicker } from "./ExtraUsagePicker";
import { formatUsd } from "./format";
import { UsageCard } from "./UsageCard";
import { useCheckoutReturn } from "./useCheckoutReturn";

function returnUrl(path: string): string {
  if (typeof window === "undefined") return path;
  return new URL(path, window.location.origin).toString();
}

function baseCheckoutRequest(entry: BillingCatalogEntry): CreateCheckoutSessionRequest {
  return {
    entryId: entry.id,
    successUrl: returnUrl("/billing?checkout=success"),
    cancelUrl: returnUrl("/billing?checkout=cancelled"),
  };
}

export function BillingPage() {
  const products = useBillingProducts();
  const transactions = useBillingTransactions();
  const checkout = useCreateCheckoutSession();
  const checkoutReturn = useCheckoutReturn();
  const stripeConfigured = products.data?.stripeConfigured ?? false;
  const entries = products.data?.entries ?? [];

  const planEntries = entries.filter((entry) => entry.kind === "plan");
  const extraEntry = entries.find((entry) => entry.kind === "extra-usage");

  // One mutation owns the live attempt: the click that started it is the only
  // control rendered pending or failed. A new attempt replaces that control.
  const request = checkout.variables;
  const pendingEntryId = checkout.isPending ? request?.entryId : undefined;
  const failedEntryId = checkout.isError ? request?.entryId : undefined;
  const failureMessage = checkout.error instanceof Error ? checkout.error.message : null;

  const errorFor = (entryId: string): string | null =>
    failedEntryId === entryId ? failureMessage : null;
  const retry = () => {
    if (request) checkout.mutate(request);
  };

  return (
    <main className="h-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-8">
        <Link
          to="/"
          className="focus-ring inline-flex w-fit items-center gap-2 rounded-md text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          <Trans>Back to workspace</Trans>
        </Link>

        <header className="space-y-2">
          <p className="text-xs font-medium tracking-[0.08em] text-muted-foreground">
            <Trans>Settings</Trans>
          </p>
          <h1 className="text-headline-section">
            <Trans>Billing</Trans>
          </h1>
          <p className="text-muted-foreground">
            <Trans>
              Your monthly plan covers included usage. Top up extra usage any time to keep going
              past your plan.
            </Trans>
          </p>
        </header>

        <CheckoutReturnNotice status={checkoutReturn} />

        <UsageCard variant="full" />

        <section className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-semibold">
              <Trans>Plans</Trans>
            </h2>
            {products.data && !stripeConfigured ? (
              <p className="text-sm text-muted-foreground">
                <Trans>Checkout unavailable.</Trans>
              </p>
            ) : null}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {planEntries.map((entry) => (
              <PlanCard
                key={entry.id}
                entry={entry}
                pending={pendingEntryId === entry.id}
                errorMessage={errorFor(entry.id)}
                onRetry={retry}
                onCheckout={(body) => checkout.mutate(body)}
              />
            ))}
            {products.data && planEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                <Trans>No plans available.</Trans>
              </p>
            ) : null}
          </div>
        </section>

        {extraEntry ? (
          <section className="space-y-3">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">
                <Trans>Extra usage</Trans>
              </h2>
              <p className="text-sm text-muted-foreground">
                <Trans>Top up any time. Extra usage carries over month to month.</Trans>
              </p>
            </div>
            <article className="surface-card p-5">
              <ExtraUsagePicker
                amountOptions={extraEntry.amountOptions}
                disabled={!extraEntry.checkoutAvailable}
                pending={pendingEntryId === extraEntry.id}
                errorMessage={errorFor(extraEntry.id)}
                onRetry={retry}
                onPurchase={(amountUsd) =>
                  checkout.mutate({ ...baseCheckoutRequest(extraEntry), amountUsd })
                }
              />
            </article>
          </section>
        ) : null}

        <section className="surface-card p-5">
          <h2 className="text-lg font-semibold">
            <Trans>Recent activity</Trans>
          </h2>
          <div className="mt-3 divide-y divide-border-subtle">
            {(transactions.data?.transactions ?? []).slice(0, 8).map((tx, index) => {
              const activityKey = `${tx.createdAt}:${tx.kind}:${tx.amountUsd}:${index}`;
              return (
                <div
                  key={activityKey}
                  className="flex items-center justify-between gap-4 py-2 text-sm"
                >
                  <span className="text-muted-foreground">{tx.label}</span>
                  <span className="font-medium tabular-nums text-foreground">
                    {formatUsd(tx.amountUsd)}
                  </span>
                </div>
              );
            })}
            {transactions.data && transactions.data.transactions.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">
                <Trans>No billing activity yet.</Trans>
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}

function PlanCard({
  entry,
  pending,
  errorMessage,
  onRetry,
  onCheckout,
}: {
  entry: BillingPlanEntry;
  pending: boolean;
  errorMessage: string | null;
  onRetry: () => void;
  onCheckout: (request: CreateCheckoutSessionRequest) => void;
}) {
  const priceLine = `${formatUsd(entry.priceUsd)} / ${entry.interval}`;

  return (
    <article className="surface-card flex flex-col gap-4 p-4">
      <div>
        <p className="font-medium">{entry.name}</p>
        <p className="mt-1 text-sm text-muted-foreground">{entry.description}</p>
      </div>
      <div className="mt-auto">
        <p className="text-2xl font-semibold tracking-tight">{priceLine}</p>
        <Button
          type="button"
          className="mt-3 w-full"
          disabled={!entry.checkoutAvailable || pending}
          aria-busy={pending || undefined}
          onClick={() => onCheckout(baseCheckoutRequest(entry))}
        >
          {pending ? <Trans>Opening checkout…</Trans> : <Trans>Subscribe</Trans>}
        </Button>
        {errorMessage ? <InlineErrorRow message={errorMessage} onRetry={onRetry} /> : null}
      </div>
    </article>
  );
}
