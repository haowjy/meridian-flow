/** Authenticated project library: select an existing body of work or begin another. */
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { Plus, Search } from "lucide-react";
import { useState } from "react";
import { useProjectListStatus } from "@/client/query/useProjectList";
import { useIndependentProjectIds, useProjectStore } from "@/client/stores";
import { MeridianMark } from "@/components/app/MeridianMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AccountMenu } from "@/features/account/AccountMenu";
import { formatRelativeTime } from "@/lib/date-groups";
import { displayProjectTitle } from "@/lib/project-title";

const COVER_TONES = ["bg-secondary", "bg-chip-primary-bg", "bg-muted", "bg-card"] as const;

export function ProjectLibrary() {
  const { projects, isError, refetch } = useProjectListStatus();
  const independentIds = useIndependentProjectIds();
  const now = useProjectStore((state) => state.now);
  const [search, setSearch] = useState("");
  const visible = projects?.filter((project) => !independentIds.has(project.id)) ?? null;
  const matches =
    visible?.filter((project) =>
      displayProjectTitle(project.title)
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
    ) ?? [];

  return (
    <main className="app-scroll h-full bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-5 pb-14 sm:px-8">
        <header className="flex items-center justify-between gap-4 border-b border-border py-4">
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

        <div className="mx-auto max-w-[44rem] pt-7 sm:pt-10">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
                <Trans>Your projects</Trans>
              </h1>
              <p className="mt-2 text-sm text-ink-muted">
                <Trans>Books, series, and story worlds in one place.</Trans>
              </p>
            </div>
            <Button asChild className="min-h-11">
              <Link to="/projects/new" preload="render">
                <Plus aria-hidden /> <Trans>Create project</Trans>
              </Link>
            </Button>
          </div>

          {visible !== null && visible.length > 0 && (
            <div className="relative mt-6 max-w-md">
              <label htmlFor="project-search" className="visually-hidden">
                <Trans>Search projects</Trans>
              </label>
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted"
              />
              <Input
                id="project-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t`Search projects`}
                className="h-11 bg-card pl-10"
              />
            </div>
          )}

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
            <section className="mt-7" aria-labelledby="project-list-heading">
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
              <div className="mb-4 flex items-baseline justify-between gap-4">
                <h2 id="project-list-heading" className="text-sm font-semibold">
                  <Trans>All projects</Trans>
                </h2>
                <span className="text-xs text-ink-muted">
                  <Plural value={matches.length} one="# project" other="# projects" />
                </span>
              </div>
              {matches.length ? (
                <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 sm:gap-x-6">
                  {matches.map((project) => {
                    const title = displayProjectTitle(project.title);
                    const tone = COVER_TONES[project.slug.charCodeAt(0) % COVER_TONES.length];
                    return (
                      <li key={project.id} className="min-w-0">
                        <Link
                          to="/p/$projectSlug/$"
                          params={{ projectSlug: project.slug, _splat: "" }}
                          className="group focus-ring block rounded-md"
                          aria-label={t`Open ${title}`}
                        >
                          <div
                            className={`flex aspect-[4/5] items-center justify-center rounded-sm border border-border p-4 text-center transition-transform duration-200 ease-out group-hover:-translate-y-1 motion-reduce:transition-none motion-reduce:transform-none ${tone}`}
                          >
                            <span className="max-w-full text-balance break-words text-base font-semibold leading-snug sm:text-lg">
                              {title}
                            </span>
                          </div>
                          <div className="mt-2 min-w-0">
                            <h3 className="truncate text-sm font-semibold">{title}</h3>
                            <p className="mt-0.5 text-xs text-ink-muted">
                              {t`Edited ${formatRelativeTime(project.updatedAt, now)}`}
                            </p>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="border-t border-border py-8 text-sm text-ink-muted" role="status">
                  <Trans>No projects match your search.</Trans>
                </p>
              )}
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
