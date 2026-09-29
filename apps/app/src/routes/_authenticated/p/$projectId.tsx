/** Authorized project identity and persistent shell lifetime for readable child destinations. */
import { Trans } from "@lingui/react/macro";
import { createFileRoute, useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { getProject } from "@/client/api/projects-api";
import { ssrApiRequestInit } from "@/client/api/ssr-api-request";
import { loadProjectRouteData } from "@/client/query/project-route-data";
import {
  readPendingProjectCreation,
  useProjectCreationState,
} from "@/client/query/useProjectCreation";
import { useProject } from "@/client/query/useProjectList";
import { Button } from "@/components/ui/button";
import { useAccountEpochSignal } from "@/features/project/context/account-feature-context";
import { ProjectCreationNotice } from "@/features/project/ProjectCreationNotice";
import { ReadableProjectRoute } from "@/features/project/routing/ReadableProjectRoute";
import { PERSISTENT_SHELL_OPTIONS } from "@/router-shell";
import { Route as AuthenticatedRoute } from "../../_authenticated";

export const Route = createFileRoute("/_authenticated/p/$projectId")({
  ...PERSISTENT_SHELL_OPTIONS,
  loader: async ({ params }) => {
    if (readPendingProjectCreation(params.projectId)) {
      return {
        projectId: params.projectId,
        project: null,
        data: null,
      };
    }
    const project = await getProject(params.projectId, ssrApiRequestInit());
    return { projectId: params.projectId, project, data: await loadProjectRouteData(project.id) };
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
  const loaderData = Route.useLoaderData();
  const { projectId } = Route.useParams();
  const { user } = AuthenticatedRoute.useLoaderData();
  const accountSignal = useAccountEpochSignal();
  const creation = useProjectCreationState(projectId, accountSignal);
  const project = useProject(projectId, loaderData.project ?? creation.project);
  // A project being created has no route data yet; the creation stands in.
  if (!project || (!loaderData.data && creation.status === "none")) return <PendingProject />;

  return (
    <ProjectIdentityBoundary projectId={projectId}>
      <div className="flex h-full min-h-0 flex-col">
        <ProjectCreationNotice creation={creation} />
        <div className="min-h-0 flex-1">
          {/* Project-scoped state (navigation, admission, seeding) never carries across projects. */}
          <ReadableProjectRoute
            key={project.id}
            project={project}
            data={loaderData.data}
            user={user}
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
