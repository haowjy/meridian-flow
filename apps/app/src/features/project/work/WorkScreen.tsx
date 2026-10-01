/** Route dispatcher for Work collection, creation, and detail destinations. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { CreationDialog } from "@/features/creation/CreationDialog";
import type { ProjectRouteCommands, RouteWorkResolution } from "../routing/project-route";
import { useCreateWork, useWorkCreationRecovery } from "./useWorkCreation";
import type { WorkDeletion } from "./useWorkDeletion";
import { WorkCollection } from "./WorkCollection";
import { WorkCreationDestination } from "./WorkCreationDestination";
import { WorkDetailScreen } from "./WorkDetailScreen";

export type WorkScreenProps = {
  projectId: string;
  routeWork: RouteWorkResolution;
  routeCommands: ProjectRouteCommands;
  deletion: WorkDeletion;
};

export function WorkScreen({ projectId, routeWork, routeCommands, deletion }: WorkScreenProps) {
  const createWork = useCreateWork(projectId, routeCommands);
  const recovery = useWorkCreationRecovery(
    projectId,
    routeWork.status === "creating" ? routeWork.workId : null,
    routeCommands,
  );

  if (routeWork.status === "new")
    return (
      <>
        <WorkCollection projectId={projectId} routeCommands={routeCommands} deletion={deletion} />
        <CreationDialog
          title={t`Create a Work`}
          nameLabel={t`What are you working on?`}
          namePlaceholder={t`Name this Work`}
          details={{
            label: t`What is your goal?`,
            placeholder: t`Draft chapters 12 to 15, the tournament arc, ending on Lin’s loss.`,
          }}
          submitLabel={t`Create Work`}
          onClose={() => void routeCommands.closeWork({ replace: true })}
          onCreate={({ name, details }) => createWork.create({ name, goal: details || undefined })}
        />
      </>
    );

  if (routeWork.status === "creating")
    return (
      <WorkCreationDestination
        name={routeWork.name}
        goal={routeWork.goal}
        failed={routeWork.phase === "failed"}
        onRetry={recovery.retry}
        onDiscard={recovery.discard}
      />
    );

  if (routeWork.status === "present")
    return (
      // Keyed: search text, scroll and tab state belong to one Work.
      <WorkDetailScreen
        key={routeWork.work.id}
        projectId={projectId}
        work={routeWork.work}
        routeCommands={routeCommands}
      />
    );

  if (routeWork.status === "unresolved" && routeWork.reason === "error")
    return <WorkResolutionError projectId={projectId} />;

  if (routeWork.status === "unresolved")
    return (
      <div className="app-scroll">
        <div className="project-screen-column">
          <p className="text-sm text-muted-foreground">
            <Trans>Loading Work…</Trans>
          </p>
        </div>
      </div>
    );

  return <WorkCollection projectId={projectId} routeCommands={routeCommands} deletion={deletion} />;
}

function WorkResolutionError({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const retry = useCallback(
    () =>
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.works(projectId),
        exact: true,
      }),
    [projectId, queryClient],
  );
  return (
    <div className="app-scroll">
      <div className="project-screen-column">
        <InlineErrorRow
          message={t`Work couldn’t load`}
          onRetry={retry}
          actionLabel={t`Retry Work`}
        />
      </div>
    </div>
  );
}
