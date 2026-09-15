/** Retain usable content during document navigation; mask unavailable destinations. */
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";

import { DelayedContentSkeleton } from "@/components/app/DelayedContentSkeleton";

export type ProjectRouteIssue = "loading" | "unavailable" | "error" | "resource-viewing";

export function ProjectRouteBoundary({
  issue,
  children,
  recovery,
  retainWhileLoading = false,
  destinationKey,
}: {
  issue?: ProjectRouteIssue;
  children: ReactNode;
  recovery?: ReactNode;
  retainWhileLoading?: boolean;
  destinationKey?: string;
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
          {issue === "resource-viewing" ? (
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
