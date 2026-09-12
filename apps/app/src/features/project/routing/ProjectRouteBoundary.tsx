/** Retain usable content during document navigation; mask unavailable destinations. */
import { Trans } from "@lingui/react/macro";
import { Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

export type ProjectRouteIssue = "loading" | "unavailable" | "error" | "resource-viewing";

export function ProjectRouteBoundary({
  issue,
  children,
  recovery,
  retainWhileLoading = false,
}: {
  issue?: ProjectRouteIssue;
  children: ReactNode;
  recovery?: ReactNode;
  retainWhileLoading?: boolean;
}) {
  const retainedPending = issue === "loading" && retainWhileLoading && !recovery;
  const blocked = (!!issue && !retainedPending) || !!recovery;
  const [showProgress, setShowProgress] = useState(false);
  useEffect(() => {
    if (!retainedPending) {
      setShowProgress(false);
      return;
    }
    const timer = setTimeout(() => setShowProgress(true), 200);
    return () => clearTimeout(timer);
  }, [retainedPending]);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" aria-busy={retainedPending}>
      <div
        className="flex min-h-0 flex-1 flex-col"
        inert={blocked}
        aria-hidden={blocked}
        style={blocked ? { visibility: "hidden" } : undefined}
      >
        {children}
      </div>
      {retainedPending && showProgress ? (
        <div
          className="pointer-events-none absolute right-3 top-3 text-muted-foreground"
          role="status"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <span className="sr-only">
            <Trans>Loading destination…</Trans>
          </span>
        </div>
      ) : null}
      {recovery ? (
        <div className="absolute inset-0 bg-background">{recovery}</div>
      ) : issue && !retainedPending ? (
        <div
          className="absolute inset-0 grid place-items-center bg-background px-6 text-center text-sm text-muted-foreground"
          role="status"
        >
          {issue === "loading" ? (
            <Trans>Loading destination…</Trans>
          ) : issue === "resource-viewing" ? (
            <Trans>
              Viewing chat resources is not available yet. These files remain available to your
              chats and AI tools.
            </Trans>
          ) : issue === "error" ? (
            <Trans>This destination couldn’t load.</Trans>
          ) : (
            <Trans>This destination is unavailable.</Trans>
          )}
        </div>
      ) : null}
    </div>
  );
}
