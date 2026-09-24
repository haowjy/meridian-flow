/** Authenticated project library: select an existing body of work or begin another. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useProjectListStatus } from "@/client/query/useProjectList";
import { useIndependentProjectIds, useProjectStore } from "@/client/stores";
import { MeridianMark } from "@/components/app/MeridianMark";
import { Button } from "@/components/ui/button";
import { AccountMenu } from "@/features/account/AccountMenu";
import { formatRelativeTime } from "@/lib/date-groups";
import { displayProjectTitle } from "@/lib/project-title";

export function ProjectLibrary() {
  const { projects, isError, refetch } = useProjectListStatus();
  const independentIds = useIndependentProjectIds();
  const now = useProjectStore((state) => state.now);
  const visible = projects?.filter((project) => !independentIds.has(project.id)) ?? null;

  return (
    <main className="app-scroll h-full bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-5 pb-14 sm:px-8">
        <header className="flex items-center justify-between gap-4 py-3">
          <Link
            to="/"
            className="focus-ring flex items-center gap-1 rounded-md text-sm font-semibold tracking-tight"
          >
            <MeridianMark className="size-7" />
            Meridian
          </Link>
          <div className="max-w-48">
            <AccountMenu />
          </div>
        </header>

        <div className="mx-auto max-w-4xl pt-4 sm:pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              <Trans>Your projects</Trans>
            </h1>
            <Button asChild size="sm" className="[@media(pointer:coarse)]:min-h-11">
              <Link to="/projects/new" preload="render">
                <Plus aria-hidden /> <Trans>Create project</Trans>
              </Link>
            </Button>
          </div>

          {isError && !visible?.length ? (
            <div className="mt-10" role="alert">
              <p className="text-sm">
                <Trans>Projects couldn’t load.</Trans>
              </p>
              <Button className="mt-3" variant="outline" onClick={() => void refetch()}>
                <Trans>Retry loading</Trans>
              </Button>
            </div>
          ) : visible === null ? (
            <p className="mt-10 text-sm text-ink-muted" role="status">
              <Trans>Loading projects…</Trans>
            </p>
          ) : visible.length === 0 ? (
            <div className="mt-10 border-t border-border py-9">
              <h2 className="text-xl font-semibold">
                <Trans>No projects yet</Trans>
              </h2>
              <p className="mt-2 text-sm text-ink-muted">
                <Trans>Create a project for your first book, series, or story world.</Trans>
              </p>
            </div>
          ) : (
            <section className="mt-4" aria-label={t`Projects`}>
              {isError && (
                <div className="mb-5 flex items-center gap-3 text-sm" role="status">
                  <span>
                    <Trans>Projects couldn’t refresh. Showing saved results.</Trans>
                  </span>
                  <Button variant="outline" size="sm" onClick={() => void refetch()}>
                    <Trans>Retry loading</Trans>
                  </Button>
                </div>
              )}
              <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {visible.map((project) => {
                  const title = displayProjectTitle(project.title);
                  return (
                    <li key={project.id} className="min-w-0">
                      <Link
                        to="/p/$projectSlug/$"
                        params={{ projectSlug: project.slug, _splat: "" }}
                        className="group focus-ring block rounded-xl"
                        aria-label={t`Open ${title}`}
                      >
                        <div className="flex aspect-[4/5] items-center justify-center rounded-xl border border-border bg-card p-4 text-center transition-transform duration-200 ease-out group-hover:-translate-y-1 motion-reduce:transition-none motion-reduce:transform-none">
                          <span
                            aria-hidden
                            className="max-w-full select-none text-balance break-words text-base font-semibold leading-snug sm:text-lg"
                          >
                            {title}
                          </span>
                        </div>
                      </Link>
                      <div className="mt-2 flex min-w-0 items-baseline gap-2">
                        <h3
                          title={title}
                          className="min-w-0 flex-1 cursor-text select-text truncate text-sm font-semibold"
                        >
                          {title}
                        </h3>
                        <p className="shrink-0 cursor-text select-text text-xs text-ink-muted">
                          {t`Edited ${formatRelativeTime(project.updatedAt, now)}`}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
