/** Authorized project identity and persistent shell lifetime for readable child destinations. */
import { Trans } from "@lingui/react/macro";
import { createFileRoute, useRouter, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { httpErrorStatus } from "@/client/api/http-client";
import { awaitPendingProjectCreation } from "@/client/query/project-commands";
import { loadProjectEntry } from "@/client/query/project-route-data";
import {
  useProjectCreationState,
  useSettleConfirmedCreation,
} from "@/client/query/useProjectCreation";
import { useProject } from "@/client/query/useProjectList";
import { Button } from "@/components/ui/button";
import { ProjectCreationNotice } from "@/features/project/ProjectCreationNotice";
import { ProjectRouteBootstrap } from "@/features/project/routing/ProjectRouteBootstrap";
import { PERSISTENT_SHELL_OPTIONS } from "@/router-shell";
import { Route as AuthenticatedRoute } from "../../_authenticated";

export const Route = createFileRoute("/_authenticated/p/$projectId")({
  ...PERSISTENT_SHELL_OPTIONS,
  // A creation this account has not had confirmed owns the destination: the shell renders from
  // its record while the POST is in flight. The server renders without the journal, so a project
  // it cannot find is left for the client to decide (`unresolved`).
  loader: async ({ params, parentMatchPromise }) => {
    const { projectId } = params;
    // The account this load is for, not the one whose provider happens to be mounted.
    const { user } = (await parentMatchPromise).loaderData ?? {};
    if (user && (await awaitPendingProjectCreation(user.userId, projectId)))
      return { projectId, project: null, data: null, unresolved: false };
    try {
      return { projectId, ...(await loadProjectEntry(projectId)), unresolved: false };
    } catch (cause) {
      if (typeof window !== "undefined" || httpErrorStatus(cause) !== 404) throw cause;
      return { projectId, project: null, data: null, unresolved: true };
    }
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
          <Trans>This project couldn’t load</Trans>
        </p>
        <Button variant="outline" onClick={() => void router.invalidate()}>
          <Trans>Retry</Trans>
        </Button>
      </div>
    </main>
  );
}

function ProjectRoute() {
  const loaderData = Route.useLoaderData();
  const { projectId } = Route.useParams();
  const { user } = AuthenticatedRoute.useLoaderData();
  const creation = useProjectCreationState(projectId);
  useSettleConfirmedCreation(projectId, loaderData.data !== null);
  // The server could not find this project; the client's loader knows whether it is an unsent create.
  const router = useRouter();
  const unresolved = loaderData.unresolved;
  useEffect(() => {
    if (unresolved) void router.invalidate({ filter: (match) => match.routeId === Route.id });
  }, [unresolved, router]);
  const project = useProject(projectId, loaderData.project ?? creation.project);
  // A project being created has no route data yet; the creation stands in.
  if (!project || (!loaderData.data && creation.status === "none")) return <PendingProject />;

  return (
    <ProjectIdentityBoundary projectId={projectId}>
      <div className="flex h-full min-h-0 flex-col">
        <ProjectCreationNotice creation={creation} />
        <div className="min-h-0 flex-1">
          {/* Project-scoped state (navigation, admission, seeding) never carries across projects. */}
          <ProjectRouteBootstrap
            key={project.id}
            project={project}
            data={loaderData.data}
            user={user}
            pending={<PendingProject />}
          />
        </div>
      </div>
    </ProjectIdentityBoundary>
  );
}

/** Fence the previous live project synchronously, before the next loader settles. */
export function ProjectIdentityBoundary({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const requestedProjectId = useRouterState({
    select: (state) => {
      try {
        return decodeURIComponent(state.location.pathname.split("/")[2] ?? "").toLowerCase();
      } catch {
        return null;
      }
    },
  });
  if (requestedProjectId !== projectId.toLowerCase()) return <PendingProject />;
  return children;
}
