/**
 * Context pane state — the single route/query/tab projection rendered by the
 * desktop document surface.
 */
import type { ProjectContextTreeDirectory } from "@meridian/contracts/protocol";
import type { ContextTab } from "@/client/stores";
import { findContextFile } from "./context-tree";

export type OptimisticContextTab = { id: string; name: string };

export type ContextPaneState =
  | { kind: "document"; tab: ContextTab }
  | { kind: "optimistic-loading"; tab: OptimisticContextTab }
  | { kind: "empty-desk" }
  | { kind: "dead-route" }
  | { kind: "route-error" };

export function deriveContextPaneState({
  activeTab,
  destination,
  tree,
  isFetching,
  isError,
  autoOpenBlocked,
}: {
  activeTab: ContextTab | null;
  destination: { path: string; optimisticTab: OptimisticContextTab } | null;
  tree: ProjectContextTreeDirectory | null;
  isFetching: boolean;
  isError: boolean;
  autoOpenBlocked: boolean;
}): ContextPaneState {
  if (activeTab) return { kind: "document", tab: activeTab };
  if (!destination || autoOpenBlocked) return { kind: "empty-desk" };

  const routeExists = tree !== null && findContextFile(tree, destination.path) !== null;
  if (routeExists || isFetching || (!tree && !isError)) {
    return { kind: "optimistic-loading", tab: destination.optimisticTab };
  }
  if (isError) return { kind: "route-error" };
  return { kind: "dead-route" };
}
