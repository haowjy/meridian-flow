/** Park unresolved route content without replacing its mounted session owner. */
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";

export type ProjectRouteIssue = "loading" | "unavailable" | "error";

export function ProjectRouteBoundary({
  issue,
  children,
  recovery,
}: {
  issue?: ProjectRouteIssue;
  children: ReactNode;
  recovery?: ReactNode;
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        className="flex min-h-0 flex-1 flex-col"
        inert={!!issue || !!recovery}
        aria-hidden={!!issue || !!recovery}
        style={issue || recovery ? { visibility: "hidden" } : undefined}
      >
        {children}
      </div>
      {recovery ? (
        <div className="absolute inset-0 bg-background">{recovery}</div>
      ) : issue ? (
        <div
          className="absolute inset-0 grid place-items-center bg-background px-6 text-center text-sm text-muted-foreground"
          role="status"
        >
          {issue === "loading" ? (
            <Trans>Loading destination…</Trans>
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
