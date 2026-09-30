/**
 * Commits the route's snapshots (query cache and working set) before the
 * readable project shell mounts. A project still being created has no data
 * yet: it mounts against an unavailable working set, then commits once more
 * when its data arrives, without remounting. Later loader echoes never re-adopt.
 */
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { type ProjectRouteData, seedProjectRouteData } from "@/client/query/project-route-data";
import { hydrateWorkingSet, type WorkingSetHydrationPlan } from "@/client/working-set";
import { ReadableProjectRoute } from "./ReadableProjectRoute";

const NO_WORKING_SET: ProjectRouteData["workingSet"] = { status: "unavailable" };

type Committed = { projectId: string; seeded: boolean; hydration: WorkingSetHydrationPlan };

export function ProjectRouteBootstrap({
  project,
  data,
  user,
  pending,
}: {
  project: Project;
  /** `null` while the project is being created. */
  data: ProjectRouteData | null;
  user: { userId: string; workingSetSyncEnabled?: boolean | null };
  pending: ReactNode;
}) {
  const queryClient = useQueryClient();
  const committedRef = useRef<Committed | null>(null);
  const [committed, setCommitted] = useState<Committed | null>(null);
  // A layout commit, not render: cache and working-set writes notify other
  // subscribers, and this still lands before the shell's queries subscribe.
  useLayoutEffect(() => {
    const current = committedRef.current;
    if (current?.projectId === project.id && (current.seeded || !data)) return;
    if (data) seedProjectRouteData(queryClient, project.id, data);
    const next: Committed = {
      projectId: project.id,
      seeded: data !== null,
      hydration: hydrateWorkingSet(
        project.id,
        data?.workingSet ?? NO_WORKING_SET,
        user.workingSetSyncEnabled === true,
      ),
    };
    committedRef.current = next;
    setCommitted(next);
  }, [data, project.id, queryClient, user.workingSetSyncEnabled]);
  if (committed?.projectId !== project.id) return pending;
  return (
    <ReadableProjectRoute project={project} entryHydration={committed.hydration} user={user} />
  );
}
