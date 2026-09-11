/** Authorized project identity and persistent shell lifetime for readable child destinations. */
import { Trans } from "@lingui/react/macro";
import { createFileRoute, useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { getProjectBySlug } from "@/client/api/projects-api";
import { ssrApiRequestInit } from "@/client/api/ssr-api-request";
import { loadProjectRouteData } from "@/client/query/project-route-data";
import { Button } from "@/components/ui/button";
import { ReadableProjectRoute } from "@/features/project/routing/ReadableProjectRoute";
import { Route as AuthenticatedRoute } from "../../_authenticated";

export const Route = createFileRoute("/_authenticated/p/$projectSlug")({
  loader: async ({ params }) => {
    const project = await getProjectBySlug(params.projectSlug.toLowerCase(), ssrApiRequestInit());
    return { project, data: await loadProjectRouteData(project.id) };
  },
  pendingMs: 0,
  pendingMinMs: 0,
  pendingComponent: PendingProject,
  errorComponent: ProjectLoadError,
  component: ProjectRoute,
});

function PendingProject() {
  return (
    <main
      className="grid h-full place-items-center bg-background text-muted-foreground"
      role="status"
    >
      <Trans>Loading project…</Trans>
    </main>
  );
}

function ProjectLoadError() {
  const router = useRouter();
  return (
    <main className="grid h-full place-items-center bg-background text-foreground">
      <div className="flex flex-col items-center gap-3" role="alert">
        <p>
          <Trans>This project couldn’t load. It may be unavailable.</Trans>
        </p>
        <Button variant="outline" onClick={() => void router.invalidate()}>
          <Trans>Retry</Trans>
        </Button>
      </div>
    </main>
  );
}

function ProjectRoute() {
  const { project, data } = Route.useLoaderData();
  const { user } = AuthenticatedRoute.useLoaderData();
  return (
    <ProjectIdentityBoundary slug={project.slug}>
      <ReadableProjectRoute key={project.id} project={project} data={data} user={user} />
    </ProjectIdentityBoundary>
  );
}

/** Fence the previous live project synchronously, before the next loader settles. */
export function ProjectIdentityBoundary({ slug, children }: { slug: string; children: ReactNode }) {
  const requestedSlug = useRouterState({
    select: (state) => {
      try {
        return decodeURIComponent(state.location.pathname.split("/")[2] ?? "").toLowerCase();
      } catch {
        return null;
      }
    },
  });
  if (requestedSlug !== slug) return <PendingProject />;
  return children;
}
