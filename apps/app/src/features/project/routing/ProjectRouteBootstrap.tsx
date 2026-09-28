/** Commit route snapshots once before mounting the readable project shell. */
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { type ProjectRouteData, seedProjectRouteData } from "@/client/query/project-route-data";
import { hydrateWorkingSet, type WorkingSetHydrationPlan } from "@/client/working-set";
import { ReadableProjectRoute } from "./ReadableProjectRoute";

export function ProjectRouteBootstrap({
  project,
  data,
  user,
  pending,
}: {
  project: Project;
  data: ProjectRouteData;
  user: { userId: string; workingSetSyncEnabled?: boolean | null };
  pending: ReactNode;
}) {
  const queryClient = useQueryClient();
  const initializedProjectId = useRef<string | null>(null);
  const [entryHydration, setEntryHydration] = useState<WorkingSetHydrationPlan | null>(null);
  useLayoutEffect(() => {
    if (initializedProjectId.current === project.id) return;
    initializedProjectId.current = project.id;
    seedProjectRouteData(queryClient, project.id, data);
    setEntryHydration(
      hydrateWorkingSet(project.id, data.workingSet, user.workingSetSyncEnabled === true),
    );
  }, [data, project.id, queryClient, user.workingSetSyncEnabled]);
  if (initializedProjectId.current !== project.id || !entryHydration) return pending;
  return <ReadableProjectRoute project={project} entryHydration={entryHydration} user={user} />;
}
