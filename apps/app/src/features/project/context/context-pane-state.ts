/**
 * Context pane state — the single route/query/tab projection rendered by the
 * desktop document surface.
 */
import { documentTitleFromUri } from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import type { ContextTab } from "@/client/stores";

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
  catalog,
  isFetching,
  isError,
  removalFenced,
}: {
  activeTab: ContextTab | null;
  destination: {
    path: string;
    scheme: ProjectContextTreeScheme;
    optimisticTab: OptimisticContextTab;
  } | null;
  catalog: CatalogContextView | null;
  isFetching: boolean;
  isError: boolean;
  removalFenced: boolean;
}): ContextPaneState {
  if (activeTab) return { kind: "document", tab: activeTab };
  if (!destination || removalFenced) return { kind: "empty-desk" };

  const routeExists = catalog?.findPath(destination.path)?.kind === "file";
  if (routeExists || isFetching || (!catalog && !isError)) {
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
