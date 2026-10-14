/** Retain usable content during document navigation; mask unavailable destinations. */
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { DelayedContentSkeleton } from "@/components/app/DelayedContentSkeleton";
import { Button } from "@/components/ui/button";

export type ProjectRouteIssue = "loading" | "unavailable" | "error" | "resource-viewing";

/** Whether the destination body is masked, including Work recovery. */
export function isProjectRouteMasked({
  issue,
  retainWhileLoading = false,
  recovery,
}: {
  issue?: ProjectRouteIssue;
  retainWhileLoading?: boolean;
  recovery?: ReactNode;
}): boolean {
  const retainedPending = issue === "loading" && retainWhileLoading;
  return (!!issue && !retainedPending) || !!recovery;
}

/** What masks a destination's body. Its navigation frame is composed outside the boundary. */
export type ProjectRouteMask = {
  issue?: ProjectRouteIssue;
  recovery?: ReactNode;
  retainWhileLoading?: boolean;
  destinationKey?: string;
  /** Offered with a failed destination: the address stays, only its reads run again. */
  onRetry?: () => void;
};

export function ProjectRouteBoundary({
  issue,
  children,
  recovery,
  retainWhileLoading = false,
  destinationKey,
  onRetry,
}: ProjectRouteMask & { children: ReactNode }) {
  const blocked = isProjectRouteMasked({ issue, retainWhileLoading, recovery });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
          blocked && <DelayedContentSkeleton key={destinationKey} className="absolute inset-0" />
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
    </div>
  );
}
