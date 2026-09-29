/** Authorized project identity and persistent shell lifetime for readable child destinations. */
import { Trans } from "@lingui/react/macro";
import { createFileRoute, useRouter, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import {
  isProjectCreationPending,
  projectCreationFailed,
  retryProjectCreation,
} from "@/client/project-creation";
import { loadProjectEntry } from "@/client/query/project-route-data";
import { Button } from "@/components/ui/button";
import { useAccountEpochSignal } from "@/features/project/context/account-feature-context";
import { ProjectRouteBootstrap } from "@/features/project/routing/ProjectRouteBootstrap";
import { PERSISTENT_SHELL_OPTIONS } from "@/router-shell";
import { Route as AuthenticatedRoute } from "../../_authenticated";

export const Route = createFileRoute("/_authenticated/p/$projectId")({
  ...PERSISTENT_SHELL_OPTIONS,
  loader: ({ params }) => loadProjectEntry(params.projectId),
  pendingMs: 0,
  pendingMinMs: 0,
  pendingComponent: PendingProject,
  errorComponent: ProjectLoadError,
  component: ProjectRoute,
});

function PendingProject() {
  const { projectId } = Route.useParams();
  const { user } = AuthenticatedRoute.useLoaderData();
  return (
    <main
      className="grid h-full place-items-center bg-background text-muted-foreground"
      role="status"
    >
      {isProjectCreationPending(projectId, user.userId) ? (
        <Trans>Creating project…</Trans>
      ) : (
        <Trans>Loading project…</Trans>
      )}
    </main>
  );
}

function ProjectLoadError() {
  const router = useRouter();
  const { projectId } = Route.useParams();
  const { user } = AuthenticatedRoute.useLoaderData();
  const accountEpoch = useAccountEpochSignal();
  const creationFailed = projectCreationFailed(projectId, user.userId);
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    if (!creationFailed) {
      await router.invalidate();
      return;
    }
    setRetrying(true);
    try {
      await retryProjectCreation(projectId, user.userId, accountEpoch);
      await router.invalidate();
    } catch {
      // The creation attempt retains its failure so this destination can retry again.
    } finally {
      setRetrying(false);
    }
  };
  return (
    <main className="grid h-full place-items-center bg-background text-foreground">
      <div className="flex flex-col items-center gap-3" role="alert">
        <p>
          {creationFailed ? (
            <Trans>This project couldn’t be created.</Trans>
          ) : (
            <Trans>This project couldn’t load. It may be unavailable.</Trans>
          )}
        </p>
        <Button variant="outline" disabled={retrying} onClick={() => void retry()}>
          {retrying ? <Trans>Creating project…</Trans> : <Trans>Retry</Trans>}
        </Button>
      </div>
    </main>
  );
}

function ProjectRoute() {
  const { project, data } = Route.useLoaderData();
  const { user } = AuthenticatedRoute.useLoaderData();
  return (
    <ProjectIdentityBoundary projectId={project.id}>
      <ProjectRouteBootstrap
        key={project.id}
        project={project}
        data={data}
        user={user}
        pending={<PendingProject />}
      />
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
