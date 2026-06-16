import { Trans } from "@lingui/react/macro";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { getAuth } from "@workos/authkit-tanstack-react-start";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { devLoginEmail } from "@/server/dev-login";

export const Route = createFileRoute("/dev-login")({
  loader: async () => {
    const { user } = await getAuth();
    if (user) {
      throw redirect({ to: "/" });
    }

    const email = await devLoginEmail();
    if (!email) {
      throw notFound();
    }

    return { email };
  },
  component: DevLoginPage,
});

type Status =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "failure"; status: number; statusText: string; body: string };

const MAX_DIAGNOSTIC_BYTES = 2048;

function truncate(body: string): string {
  if (body.length <= MAX_DIAGNOSTIC_BYTES) return body;
  return `${body.slice(0, MAX_DIAGNOSTIC_BYTES)}\n\n[... truncated ${body.length - MAX_DIAGNOSTIC_BYTES} bytes ...]`;
}

function DevLoginPage() {
  const { email } = Route.useLoaderData();
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function attemptLogin() {
    setStatus({ kind: "pending" });

    let response: Response;
    try {
      response = await fetch("/api/auth/dev-login", {
        method: "GET",
        redirect: "manual",
        credentials: "same-origin",
      });
    } catch (error) {
      setStatus({
        kind: "failure",
        status: 0,
        statusText: "Network error",
        body: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (response.type === "opaqueredirect") {
      window.location.href = "/";
      return;
    }

    const body = await response.text().catch((error) => `(failed to read body: ${String(error)})`);
    setStatus({
      kind: "failure",
      status: response.status,
      statusText: response.statusText || "(no status text)",
      body: truncate(body),
    });
  }

  return (
    <main className="flex min-h-svh items-start justify-center bg-background p-6 sm:items-center">
      <div className="w-full max-w-xl space-y-6">
        <header className="space-y-2">
          <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            <Trans>Dev login</Trans>
          </p>
          <h1 className="text-2xl font-semibold text-foreground">
            <Trans>Sign in as the development user</Trans>
          </h1>
          <p className="text-sm text-muted-foreground">
            <Trans>
              This page exists only when WORKOS_DEV_AUTOLOGIN is enabled. Clicking the button below
              performs a real WorkOS password authentication and mints the same session cookie as
              the production sign-in flow.
            </Trans>
          </p>
        </header>

        <section className="rounded-lg border border-border bg-card p-4">
          <dl className="grid grid-cols-[max-content_1fr] items-baseline gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">
              <Trans>Identity</Trans>
            </dt>
            <dd className="font-mono text-foreground break-all">{email}</dd>
          </dl>
        </section>

        <div className="flex flex-col gap-2">
          <Button
            onClick={attemptLogin}
            size="lg"
            variant="default"
            disabled={status.kind === "pending"}
          >
            {status.kind === "pending" ? (
              <Trans>Signing in…</Trans>
            ) : status.kind === "failure" ? (
              <Trans>Retry sign-in</Trans>
            ) : (
              <Trans>Sign in as dev user</Trans>
            )}
          </Button>
        </div>

        {status.kind === "failure" ? <DiagnosticPanel status={status} /> : null}
      </div>
    </main>
  );
}

function DiagnosticPanel({ status }: { status: Extract<Status, { kind: "failure" }> }) {
  return (
    <section
      aria-live="polite"
      className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
    >
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-destructive">
          <Trans>Dev-login failed</Trans>
        </h2>
        <p className="font-mono text-xs text-destructive">
          {status.status} {status.statusText}
        </p>
      </header>
      <pre className="max-h-96 overflow-auto rounded-md border border-border-subtle bg-surface-subtle p-3 font-mono text-xs whitespace-pre-wrap text-foreground">
        {status.body || "(empty response body)"}
      </pre>
      <p className="text-xs text-muted-foreground">
        <Trans>
          The endpoint reports its own env-presence checklist in the body above (presence only,
          never values). Fix the indicated env var in your gitignored .env and restart the dev
          server before retrying.
        </Trans>
      </p>
    </section>
  );
}
