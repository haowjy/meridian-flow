/** Synchronous accepted-history adapter for coordinator and mounted-surface tests. */
import type { ContextRemovalRoutePort } from "@/features/project/context/context-removal-coordinator";
import type {
  NavigationSettlement,
  PreparedWorkspaceNavigation,
} from "@/features/project/routing/project-navigation";
import {
  type ContextRouteTarget,
  openContextRouteSearch,
} from "@/features/project/routing/project-route";

export async function acceptContextTransition(
  this: ContextRemovalRoutePort,
  projectId: string,
  target: ContextRouteTarget | { kind: "clear" },
  prepared: PreparedWorkspaceNavigation,
): Promise<NavigationSettlement> {
  if (!prepared.isCurrent()) return { kind: "superseded" };
  this.updateSearch(projectId, (current) => {
    if (!("kind" in target)) return openContextRouteSearch(current, target);
    const next = { ...current };
    delete next.scheme;
    delete next.path;
    delete next.folder;
    delete next.results;
    return next;
  });
  prepared.commit();
  return { kind: "applied" };
}
