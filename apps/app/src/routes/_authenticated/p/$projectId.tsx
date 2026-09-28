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
import { ReadableProjectRoute } from "@/features/project/routing/ReadableProjectRoute";
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
  return (
    <main
      className="grid h-full place-items-center bg-background text-muted-foreground"
      role="status"
    >
      {isProjectCreationPending(projectId) ? (
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
  const creationFailed = projectCreationFailed(projectId);
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    if (!creationFailed) {
      await router.invalidate();
      return;
    }
    setRetrying(true);
    try {
      await retryProjectCreation(projectId);
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
      <ReadableProjectRoute key={project.id} project={project} data={data} user={user} />
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
