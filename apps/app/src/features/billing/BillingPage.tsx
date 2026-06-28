/**
 * /billing — usage summary, catalog (subscription plans + extra usage), and
 * recent activity. The server emits USD strings + percentages; this page is
 * pure presentation over those values.
 *
 * Purchase actions go through Stripe Checkout / Customer Portal — the create
 * mutation returns a discriminated `{ kind: "checkout" | "portal", url }` and
 * the hook redirects. When `stripeConfigured` is false the action surface
 * shows a quiet "checkout unavailable" note instead of dead buttons.
 *
 * Plans have a fixed `priceUsd` + interval and a Subscribe button. Extra
 * usage has `amountOptions` instead — the user picks an amount via
 * `ExtraUsagePicker` and that value becomes `amountUsd` in the request.
 */
import { Trans } from "@lingui/react/macro";
import type {
  BillingCatalogEntry,
  CreateCheckoutSessionRequest,
} from "@meridian/contracts/protocol";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import {
  useBillingProducts,
  useBillingTransactions,
  useCreateCheckoutSession,
} from "@/client/query/useBilling";
import { Button } from "@/components/ui/button";
import { ExtraUsagePicker } from "./ExtraUsagePicker";
import { formatUsd } from "./format";
import { UsageCard } from "./UsageCard";

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
  const stripeConfigured = products.data?.stripeConfigured ?? false;
  const entries = products.data?.entries ?? [];
  const actionsDisabled = !stripeConfigured || checkout.isPending;

  return (
    <main className="app-scroll bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
        <Link
          to="/"
          className="focus-ring inline-flex w-fit items-center gap-2 rounded-md text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          <Trans>Back to workspace</Trans>
        </Link>

        <header className="space-y-2">
          <p className="text-eyebrow text-muted-foreground">
            <Trans>Settings</Trans>
          </p>
          <h1 className="text-headline-section">
            <Trans>Billing</Trans>
          </h1>
          <p className="max-w-2xl text-muted-foreground">
            <Trans>
              Your monthly plan covers included usage. Buy extra usage to keep going past your plan
              in any month, at any time.
            </Trans>
          </p>
        </header>

        <UsageCard variant="full" />

        <section className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-semibold">
              <Trans>Plans and extra usage</Trans>
            </h2>
            {products.data && !stripeConfigured ? (
              <p className="text-sm text-muted-foreground">
                <Trans>Checkout unavailable.</Trans>
              </p>
            ) : null}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {entries.map((entry) => (
              <CatalogCard
                key={entry.id}
                entry={entry}
                disabled={actionsDisabled}
                onCheckout={(request) => checkout.mutate(request)}
              />
            ))}
            {products.data && entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                <Trans>No products available.</Trans>
              </p>
            ) : null}
          </div>
        </section>

        <section className="surface-card p-5">
          <h2 className="text-lg font-semibold">
            <Trans>Recent activity</Trans>
          </h2>
          <div className="mt-3 divide-y divide-border-subtle">
            {(transactions.data?.transactions ?? []).slice(0, 8).map((tx) => (
              <div key={tx.id} className="flex items-center justify-between gap-4 py-2 text-sm">
                <span className="text-muted-foreground">{tx.reason ?? tx.transactionType}</span>
                <span className="font-medium tabular-nums text-foreground">
                  {formatUsd(tx.amountUsd)}
                </span>
              </div>
            ))}
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

function CatalogCard({
  entry,
  disabled,
  onCheckout,
}: {
  entry: BillingCatalogEntry;
  disabled: boolean;
  onCheckout: (request: CreateCheckoutSessionRequest) => void;
}) {
  return (
    <article className="surface-card flex flex-col gap-4 p-4">
      <div>
        <p className="font-medium">{entry.name}</p>
        <p className="mt-1 text-sm text-muted-foreground">{entry.description}</p>
      </div>
      <div className="mt-auto">
        {entry.kind === "plan" ? (
          <PlanAction entry={entry} disabled={disabled} onCheckout={onCheckout} />
        ) : entry.amountOptions ? (
          <ExtraUsagePicker
            amountOptions={entry.amountOptions}
            disabled={disabled}
            onPurchase={(amountUsd) => onCheckout({ ...baseCheckoutRequest(entry), amountUsd })}
          />
        ) : null}
      </div>
    </article>
  );
}

function PlanAction({
  entry,
  disabled,
  onCheckout,
}: {
  entry: BillingCatalogEntry;
  disabled: boolean;
  onCheckout: (request: CreateCheckoutSessionRequest) => void;
}) {
  // Plans always carry `priceUsd` in the products contract; the optional
  // field exists so extra-usage can omit it. Render nothing if the server
  // ever drops it rather than printing "$NaN".
  if (!entry.priceUsd) return null;
  const priceLine = entry.interval
    ? `${formatUsd(entry.priceUsd)} / ${entry.interval}`
    : formatUsd(entry.priceUsd);

  return (
    <>
      <p className="text-2xl font-semibold tracking-tight">{priceLine}</p>
      <Button
        type="button"
        className="mt-3 w-full"
        disabled={disabled}
        onClick={() => onCheckout(baseCheckoutRequest(entry))}
      >
        <Trans>Subscribe</Trans>
      </Button>
    </>
  );
}
