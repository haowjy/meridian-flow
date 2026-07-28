/**
 * Context pane state — the single route/query/tab projection rendered by the
 * desktop document surface.
 */
import { documentTitleFromUri } from "@meridian/contracts/context-uri";
import type {
  ProjectContextTreeDirectory,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import type { ContextTab } from "@/client/stores";

export function findActiveUntitledTab(
  tabs: readonly ContextTab[],
  activeTabId: string | null,
): Extract<ContextTab, { kind: "new" }> | null {
  if (!activeTabId) return null;
  const tab = tabs.find((candidate) => candidate.documentId === activeTabId);
  return tab?.kind === "new" ? tab : null;
}

import { findContextFile } from "./context-tree";

export type OptimisticContextTab = { id: string; name: string };

/**
 * What the route asked for and didn't find. The timeline promises the URI the
 * agent used, not that the document still exists, so this pane is where that
 * promise gets settled: it has to be able to say which document went missing.
 */
export type MissingDestination = { name: string; scheme: ProjectContextTreeScheme };

export type ContextPaneState =
  | { kind: "document"; tab: ContextTab }
  | { kind: "optimistic-loading"; tab: OptimisticContextTab }
  | { kind: "empty-desk" }
  | { kind: "dead-route"; destination: MissingDestination }
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
  destination: {
    path: string;
    scheme: ProjectContextTreeScheme;
    optimisticTab: OptimisticContextTab;
  } | null;
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
  return {
    kind: "dead-route",
    destination: {
      name: documentTitleFromUri(destination.path) ?? destination.optimisticTab.name,
      scheme: destination.scheme,
    },
  };
}
