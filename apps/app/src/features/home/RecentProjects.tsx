import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useVisibleProjects } from "@/client/query/useProjectList";
import { useProjectStore, useThreadStore } from "@/client/stores";
import { formatRelativeTime } from "@/lib/date-groups";
import { displayProjectTitle } from "@/lib/project-title";

/** Number of recent projects shown on Home. */
const RECENT_LIMIT = 6;

/**
 * Home "Recent projects" grid (max 6, 2 columns on sm+). `null` = loading
 * (renders nothing — the parent decides skeleton state); `[]` = empty.
 */
export function RecentProjects() {
  const projects = useVisibleProjects();
  const now = useProjectStore((s) => s.now);
  const streamingProjectId = useThreadStore((s) => s.streamingProjectId);

  if (projects === null) return null;

  const recent = [...projects]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, RECENT_LIMIT);

  return (
    <section className="mt-12" aria-labelledby="home-recent-heading">
      <h2 id="home-recent-heading" className="mb-3 text-headline-section tracking-tight">
        <Trans>Recent projects</Trans>
      </h2>

      {recent.length > 0 ? (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {recent.map((project) => {
            const isStreaming = project.id === streamingProjectId;
            return (
              <li key={project.id}>
                <Link
                  to="/project/$projectId"
                  params={{ projectId: project.id }}
                  className="focus-ring surface-card block rounded-lg px-4 py-3 transition-colors hover:bg-muted"
                >
                  <div className="flex items-center gap-2">
                    {isStreaming ? (
                      <>
                        <span aria-hidden className="streaming-dot" />
                        <span className="visually-hidden">{t`Streaming`}</span>
                      </>
                    ) : null}
                    <span className="line-clamp-2 text-sm font-medium text-foreground">
                      {displayProjectTitle(project.title)}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatRelativeTime(project.updatedAt, now)}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          <Trans>No projects yet.</Trans>
        </p>
      )}
    </section>
  );
}
