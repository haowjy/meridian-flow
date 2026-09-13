/** Retain usable content during document navigation; mask unavailable destinations. */
import { Trans } from "@lingui/react/macro";
import { type ReactNode, useEffect, useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";

export type ProjectRouteIssue = "loading" | "unavailable" | "error" | "resource-viewing";

/** Only this fallback remounts when a pending destination changes, never the editor. */
function DelayedDestinationSkeleton() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 500);
    return () => clearTimeout(timer);
  }, []);
  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute inset-0 px-6 py-8" aria-hidden>
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <Skeleton className="h-7 w-1/3 motion-reduce:animate-none" />
        <Skeleton className="mt-4 h-4 w-full motion-reduce:animate-none" />
        <Skeleton className="h-4 w-full motion-reduce:animate-none" />
        <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
      </div>
    </div>
  );
}

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
        !retainedPending && <DelayedDestinationSkeleton key={destinationKey} />
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
