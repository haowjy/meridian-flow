/**
 * Seeds the query cache and the working set from the project route's loader
 * data. A project still being created has no data yet; it seeds once that
 * data arrives, without remounting the route.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { type ProjectRouteData, seedProjectRouteData } from "@/client/query/project-route-data";
import { hydrateWorkingSet } from "@/client/working-set";
import type { WorkingSetHydrationPlan } from "@/client/working-set/hydration";

const NO_WORKING_SET: ProjectRouteData["workingSet"] = { status: "unavailable" };

export function useProjectRouteData(
  projectId: string,
  /** `null` while the project is being created. */
  data: ProjectRouteData | null,
  workingSetSyncEnabled: boolean,
): WorkingSetHydrationPlan {
  const queryClient = useQueryClient();
  const seeded = useRef<{ data: ProjectRouteData | null; hydration: WorkingSetHydrationPlan }>(
    null,
  );
  // Before first paint, so no query starts a read the seed already answers.
  if (!seeded.current || (seeded.current.data === null && data !== null)) {
    if (data) seedProjectRouteData(queryClient, projectId, data);
    seeded.current = {
      data,
      hydration: hydrateWorkingSet(
        projectId,
        data?.workingSet ?? NO_WORKING_SET,
        workingSetSyncEnabled,
      ),
    };
  }
  return seeded.current.hydration;
}
