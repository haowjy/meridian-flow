import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, CreditCard } from "lucide-react";
import {
  useBillingBalance,
  useBillingPacks,
  useBillingTransactions,
  useCreateCheckoutSession,
} from "@/client/query/useBilling";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { creditsFromMillicredits } from "./format";

function returnUrl(path: string): string {
  if (typeof window === "undefined") return path;
  return new URL(path, window.location.origin).toString();
}

export function BillingPage() {
  const balance = useBillingBalance();
  const packs = useBillingPacks();
  const transactions = useBillingTransactions();
  const checkout = useCreateCheckoutSession();
  const provider = packs.data?.provider;
  const entries = packs.data?.entries.filter((entry) => entry.kind !== "needs-credentials") ?? [];

  return (
    <main className="app-frame bg-background text-foreground">
      <div className="app-scroll">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
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
              <Trans>Billing and credits</Trans>
            </h1>
            <p className="max-w-2xl text-muted-foreground">
              <Trans>
                Meridian uses credits only: every agent turn spends from free monthly credits,
                subscription credits, then purchased bundles.
              </Trans>
            </p>
          </header>

          {provider?.needsCredentials ? (
            <Alert>
              <CreditCard aria-hidden />
              <AlertTitle>
                <Trans>Fake checkout is active</Trans>
              </AlertTitle>
              <AlertDescription>{provider.message}</AlertDescription>
            </Alert>
          ) : null}

          <section className="grid gap-4 md:grid-cols-[1.2fr_0.8fr]">
            <div className="surface-card p-5">
              <p className="text-sm text-muted-foreground">
                <Trans>Current balance</Trans>
              </p>
              <div className="mt-2 text-4xl font-semibold tracking-tight">
                {balance.data
                  ? creditsFromMillicredits(balance.data.totalBalanceMillicredits)
                  : "—"}
                <span className="ml-2 text-base font-normal text-muted-foreground">
                  <Trans>credits</Trans>
                </span>
              </div>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.min(balance.data?.includedUsagePercent ?? 0, 100)}%` }}
                />
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                <Trans>Included usage: {balance.data?.includedUsagePercent ?? 0}% used.</Trans>
              </p>
            </div>

            <div className="surface-card p-5">
              <p className="text-sm text-muted-foreground">
                <Trans>Credit buckets</Trans>
              </p>
              <dl className="mt-3 space-y-2 text-sm">
                <Bucket label="Free monthly" value={balance.data?.grantBalanceMillicredits} />
                <Bucket
                  label="Subscription"
                  value={balance.data?.subscriptionBalanceMillicredits}
                />
                <Bucket label="Purchased" value={balance.data?.purchasedBalanceMillicredits} />
              </dl>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">
              <Trans>Buy credits</Trans>
            </h2>
            <div className="grid gap-3 md:grid-cols-3">
              {entries.map((entry) => (
                <article key={entry.id} className="surface-card flex flex-col gap-4 p-4">
                  <div>
                    <p className="font-medium">{entry.name}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{entry.description}</p>
                  </div>
                  <div className="mt-auto">
                    <p className="text-2xl font-semibold">
                      {entry.kind === "payg" ? "PAYG" : `${entry.credits.toLocaleString()} credits`}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {entry.interval
                        ? `$${entry.priceUsd}/${entry.interval}`
                        : `$${entry.priceUsd}`}
                    </p>
                    {entry.kind === "payg" ? (
                      <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                        <CheckCircle2 className="size-4" aria-hidden />
                        <Trans>Enabled by default</Trans>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        className="mt-3 w-full"
                        disabled={checkout.isPending}
                        onClick={() =>
                          checkout.mutate({
                            entryId: entry.id,
                            successUrl: returnUrl("/billing?checkout=success"),
                            cancelUrl: returnUrl("/billing?checkout=cancelled"),
                          })
                        }
                      >
                        <Trans>Checkout</Trans>
                      </Button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="surface-card p-5">
            <h2 className="text-lg font-semibold">
              <Trans>Recent usage</Trans>
            </h2>
            <div className="mt-3 divide-y divide-border-subtle">
              {(transactions.data?.transactions ?? []).slice(0, 8).map((tx) => (
                <div key={tx.id} className="flex items-center justify-between gap-4 py-2 text-sm">
                  <span className="text-muted-foreground">{tx.reason ?? tx.transactionType}</span>
                  <span className="font-medium">
                    {creditsFromMillicredits(tx.amountMillicredits)} credits
                  </span>
                </div>
              ))}
              {transactions.data?.transactions.length === 0 ? (
                <p className="py-3 text-sm text-muted-foreground">
                  <Trans>No billing activity yet.</Trans>
                </p>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function Bucket({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value ? creditsFromMillicredits(value) : "—"}</dd>
    </div>
  );
}
