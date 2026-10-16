/**
 * Context pane state — the single route/query/tab projection rendered by the
 * desktop document surface.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ContextTab } from "@/client/stores";
import { sameServerContextTabLocator } from "@/client/stores";
import { isProjectRouteMasked, type ProjectRouteMask } from "../routing/ProjectRouteBoundary";

export type OptimisticContextTab = { id: string; name: string };

export type ContextPaneState =
  | { kind: "document"; tab: ContextTab }
  /**
   * `settledTab` is the workspace tab already standing for the destination; it
   * is the strip's one entry while the body loads, so no chip renders.
   */
  | { kind: "optimistic-loading"; tab: OptimisticContextTab; settledTab: ContextTab | null }
  | { kind: "empty-workspace" };

/**
 * The pane never decides whether the document exists. Admission (address, catalog, draft
 * and tab) belongs to the route, and so does presenting a terminal verdict:
 * `ProjectRouteBoundary` says "unavailable" or "couldn't load" (with its retry) over the
 * pane. Everything the pane renders short of a document is a neutral wait for the
 * destination's tab, so one verdict never has two presentations.
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

  const settledTab =
    tabs.find((tab) => tab.kind !== "new" && sameServerContextTabLocator(tab, destination)) ?? null;
  return { kind: "optimistic-loading", tab: destination.optimisticTab, settledTab };
}
