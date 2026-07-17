/** Pure precedence rules for reconciling loader and device working-set state. */

import type { ProjectWorkingSet } from "@meridian/contracts/protocol";
import type { ProjectRouteData } from "@/client/query/project-route-data";
import type { ProjectWorkingSetRecord } from "./store";

export type WorkingSetHydrationPlan =
  | { status: "disabled" }
  | { status: "read-degraded" }
  | { status: "local"; revision: number | null }
  | { status: "server"; row: ProjectWorkingSet };

export function reduceWorkingSetHydration(
  result: ProjectRouteData["workingSet"],
  local: ProjectWorkingSetRecord | undefined,
): Exclude<WorkingSetHydrationPlan, { status: "disabled" }> {
  if (result.status === "unavailable") return { status: "read-degraded" };
  if (result.status === "absent") return { status: "local", revision: null };
  if (local?.pending?.baseRevision === result.row.revision) {
    return { status: "local", revision: result.row.revision };
  }
  return { status: "server", row: result.row };
}

/** The account toggle guards the precedence machine rather than adding a case to it. */
export function planWorkingSetHydration(
  enabled: boolean,
  result: ProjectRouteData["workingSet"],
  local: ProjectWorkingSetRecord | undefined,
): WorkingSetHydrationPlan {
  return enabled ? reduceWorkingSetHydration(result, local) : { status: "disabled" };
}
