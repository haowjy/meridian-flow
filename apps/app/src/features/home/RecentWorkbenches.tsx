// @ts-nocheck
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useVisibleWorkbenches } from "@/client/query/useWorkbenchList";
import { useThreadStore, useWorkbenchStore } from "@/client/stores";
import { formatRelativeTime } from "@/lib/date-groups";
import { displayWorkbenchTitle } from "@/lib/workbench-title";

/** Number of recent workbenches shown on Home. */
const RECENT_LIMIT = 6;

/**
 * Home "Recent workbenches" grid (max 6, 2 columns on sm+). `null` = loading
 * (renders nothing — the parent decides skeleton state); `[]` = empty.
 */
export function RecentWorkbenches() {
  const workbenches = useVisibleWorkbenches();
  const now = useWorkbenchStore((s) => s.now);
  const streamingWorkbenchId = useThreadStore((s) => s.streamingWorkbenchId);

  if (workbenches === null) return null;

  const recent = [...workbenches]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, RECENT_LIMIT);

  return (
    <section className="mt-12" aria-labelledby="home-recent-heading">
      <h2
        id="home-recent-heading"
        className="mb-3 text-headline-section font-semibold tracking-tight"
      >
        <Trans>Recent workbenches</Trans>
      </h2>

      {recent.length > 0 ? (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {recent.map((workbench) => {
            const isStreaming = workbench.id === streamingWorkbenchId;
            return (
              <li key={workbench.id}>
                <Link
                  to="/workbench/$workbenchId"
                  params={{ workbenchId: workbench.id }}
                  className="focus-ring surface-card block rounded-lg px-4 py-3 transition-colors hover:bg-muted/40"
                >
                  <div className="flex items-center gap-2">
                    {isStreaming ? (
                      <>
                        <span aria-hidden className="streaming-dot" />
                        <span className="visually-hidden">{t`Streaming`}</span>
                      </>
                    ) : null}
                    <span className="line-clamp-2 text-sm font-medium text-foreground">
                      {displayWorkbenchTitle(workbench.title)}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatRelativeTime(workbench.updatedAt, now)}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          <Trans>No workbenches yet.</Trans>
        </p>
      )}
    </section>
  );
}
