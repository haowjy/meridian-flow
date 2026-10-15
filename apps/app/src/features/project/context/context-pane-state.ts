/**
 * Context pane state — the single route/query/tab projection rendered by the
 * desktop document surface.
 */
import { documentTitleFromUri } from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ContextTab } from "@/client/stores";
import { sameServerContextTabLocator } from "@/client/stores";
import { isProjectRouteMasked, type ProjectRouteMask } from "../routing/ProjectRouteBoundary";

export type OptimisticContextTab = { id: string; name: string };

/**
 * What the route asked for and didn't find. The timeline promises the URI the
 * agent used, not that the document still exists, so this pane is where that
 * promise gets settled: it has to be able to say which document went missing.
 */
export type MissingDestination = { name: string; scheme: ProjectContextTreeScheme };

export type ContextPaneState =
  | { kind: "document"; tab: ContextTab }
  /**
   * `settledTab` is the workspace tab already standing for the destination; it
   * is the strip's one entry while the body loads, so no chip renders.
   */
  | { kind: "optimistic-loading"; tab: OptimisticContextTab; settledTab: ContextTab | null }
  | { kind: "empty-workspace" }
  | { kind: "dead-route"; destination: MissingDestination }
  | { kind: "route-error" };

/**
 * The pane presents the route's verdict; it never re-decides whether the document exists.
 * Admission (address, catalog, draft and tab) belongs to the route and reaches here as
 * `mask.issue`: only a terminal issue renders missing or error content, and everything
 * short of one is a neutral wait for the destination's tab.
 */
export function deriveContextPaneState({
  activeTab,
  tabs,
  mask,
  destination,
  removalFenced,
}: {
  activeTab: ContextTab | null;
  tabs: readonly ContextTab[];
  /** The route's verdict on the Editor destination. */
  mask: ProjectRouteMask;
  destination: {
    path: string;
    scheme: ProjectContextTreeScheme;
    workId?: string;
    rootThreadId?: string;
    optimisticTab: OptimisticContextTab;
  } | null;
  removalFenced: boolean;
}): ContextPaneState {
  if (activeTab && !isProjectRouteMasked(mask)) return { kind: "document", tab: activeTab };
  if (!destination || removalFenced) return { kind: "empty-workspace" };

  if (!mask.recovery) {
    if (mask.issue === "unavailable")
      return {
        kind: "dead-route",
        destination: {
          name: documentTitleFromUri(destination.path) ?? destination.optimisticTab.name,
          scheme: destination.scheme,
        },
      };
    if (mask.issue === "error") return { kind: "route-error" };
  }
  const settledTab =
    tabs.find((tab) => tab.kind !== "new" && sameServerContextTabLocator(tab, destination)) ?? null;
  return { kind: "optimistic-loading", tab: destination.optimisticTab, settledTab };
}
