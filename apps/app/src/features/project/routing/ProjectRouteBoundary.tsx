/** Retain usable content during document navigation; mask unavailable destinations. */
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { DelayedContentSkeleton } from "@/components/app/DelayedContentSkeleton";
import { Button } from "@/components/ui/button";

export type ProjectRouteIssue = "loading" | "unavailable" | "error" | "resource-viewing";

export function ProjectRouteBoundary({
  issue,
  children,
  recovery,
  retainWhileLoading = false,
  destinationKey,
  onRetry,
}: {
  issue?: ProjectRouteIssue;
  children: ReactNode;
  recovery?: ReactNode;
  retainWhileLoading?: boolean;
  destinationKey?: string;
  /** Offered with a failed destination: the address stays, only its reads run again. */
  onRetry?: () => void;
}) {
  const retainedPending = issue === "loading" && retainWhileLoading && !recovery;
  const blocked = (!!issue && !retainedPending) || !!recovery;
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      aria-busy={issue === "loading" && !recovery}
    >
      <div
        className="flex min-h-0 flex-1 flex-col"
        inert={blocked}
        aria-hidden={blocked}
        style={blocked ? { visibility: "hidden" } : undefined}
      >
        {children}
      </div>
      {recovery ? (
        <div className="absolute inset-0 bg-background">{recovery}</div>
      ) : issue === "loading" ? (
        !retainedPending && (
          <DelayedContentSkeleton key={destinationKey} className="absolute inset-0" />
        )
      ) : issue ? (
        <div
          className="absolute inset-0 grid place-items-center bg-background px-6 text-center text-sm text-muted-foreground"
          role="status"
        >
          {issue === "error" && onRetry ? (
            <div className="flex flex-col items-center gap-3">
              <p>
                <Trans>This destination couldn’t load.</Trans>
              </p>
              <Button size="sm" variant="outline" onClick={onRetry}>
                <Trans>Retry</Trans>
              </Button>
            </div>
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
