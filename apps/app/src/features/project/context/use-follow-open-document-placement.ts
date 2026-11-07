/**
 * useFollowOpenDocumentPlacement — take the Editor route to wherever the replica
 * now places the open document, and close a tab the replica no longer places.
 *
 * Desktop and phone both need this. The phone host derives its document from the
 * URL's catalog, so a move that leaves that catalog would otherwise strand the
 * editor on the old path.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useEffect } from "react";
import { useContextTabs, useContextTabsActions } from "@/client/stores";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import { sameContextTarget } from "../routing/project-route";
import {
  useAccountResourceProjection,
  useContextRemovalCoordinator,
  useProjectContextAvailabilityCoordinator,
} from "./account-feature-context";
import { routeTargetForTab } from "./context-removal-planner";
import { type ContextRouteSelection, routeSelectionDocumentId } from "./context-removal-protocol";
import { projectResourceTab } from "./context-tab-from-file";

export function useFollowOpenDocumentPlacement(input: {
  projectId: string;
  editorWorkId: string | null | undefined;
  /** The route follows a document only while the selection is bound to it at this route. */
  selection: ContextRouteSelection;
  activeContextScheme: ProjectContextTreeScheme | null;
  activeContextPath: string | null;
  activeContextChat?: string | null;
  /** The review item the address carries, when it is a review address. */
  reviewItemKey?: string;
  routeDisplayed: boolean;
  onOpenContextTarget: OpenContextRoute;
}): void {
  const { tabs } = useContextTabs(input.projectId);
  const { reconcileResourceTab } = useContextTabsActions();
  const resourceProjection = useAccountResourceProjection(input.projectId);
  const contextRemoval = useContextRemovalCoordinator();
  const availability = useProjectContextAvailabilityCoordinator();

  useEffect(() => {
    const route =
      input.editorWorkId && input.activeContextScheme !== null && input.activeContextPath !== null
        ? {
            scheme: input.activeContextScheme,
            path: input.activeContextPath,
            workId: input.editorWorkId,
            rootThreadId: input.activeContextChat ?? undefined,
          }
        : null;
    const boundDocumentId = route ? routeSelectionDocumentId(input.selection, route) : null;
    for (const tab of tabs) {
      const projection = projectResourceTab(
        input.projectId,
        tab,
        resourceProjection.records,
        resourceProjection.placement,
      );
      if (projection.kind === "none") continue;
      if (projection.kind === "terminal") {
        // A terminal resource has already disappeared from the live catalog. Close its
        // represented tab through the same removal path as an optimistic disappearance;
        // closeVanished keeps live drafts open while ordinary tabs leave silently.
        settleWriterClose(contextRemoval.closeVanished(input.projectId, tab));
        void availability
          .acceptCommittedDelete({
            projectId: input.projectId,
            deletedDocumentIds: projection.documentIds,
            generation: projection.generation,
            deletionVersion: projection.deletionVersion,
          })
          .catch((error: unknown) => reportError(error));
        continue;
      }
      if (projection.kind === "removed") {
        settleWriterClose(contextRemoval.closeVanished(input.projectId, tab));
        continue;
      }
      // A route is the tab's only while the selection is bound to it there; a URL the writer
      // just pasted or traversed to is never pulled back to an open tab's placement. A review
      // address owns its path (the draft's, which the live placement does not show).
      const routeFollowsTab =
        input.routeDisplayed &&
        input.reviewItemKey === undefined &&
        route !== null &&
        tab.kind !== "new" &&
        projection.tab.kind !== "new" &&
        boundDocumentId === tab.documentId &&
        !sameContextTarget(routeTargetForTab(projection.tab, route.workId), route);
      if (routeFollowsTab && projection.tab.kind !== "new")
        void input
          .onOpenContextTarget(
            {
              scheme: projection.tab.scheme,
              path: projection.tab.path,
              workId: projection.tab.workId ?? input.editorWorkId ?? undefined,
              ...(projection.tab.rootThreadId ? { rootThreadId: projection.tab.rootThreadId } : {}),
              documentId: projection.tab.documentId,
            },
            // Keep the tab at the route's old locator until replacement is accepted. The
            // prepared tab and address then commit together, so admission can retain the
            // already-open document by identity while a move or rename is in flight.
            { replace: true, tab: projection.tab },
          )
          .then(
            (settlement) => {
              if (settlement.kind === "failed") reportError(settlement.error);
            },
            (error: unknown) => reportError(error),
          );
      else
        void reconcileResourceTab(input.projectId, projection.resourceHandle, projection.tab).catch(
          (error: unknown) => reportError(error),
        );
    }
  }, [
    input.activeContextChat,
    input.activeContextPath,
    input.activeContextScheme,
    input.editorWorkId,
    input.onOpenContextTarget,
    input.projectId,
    input.reviewItemKey,
    input.routeDisplayed,
    input.selection,
    availability,
    contextRemoval,
    reconcileResourceTab,
    resourceProjection.records,
    resourceProjection.placement,
    tabs,
  ]);
}

export function settleWriterClose(
  result: ReturnType<ReturnType<typeof useContextRemovalCoordinator>["writerClose"]>,
): void {
  if (!(result instanceof Promise)) return;
  void result.then(
    (settlement) => {
      if (settlement.kind === "failed") reportError(settlement.error);
    },
    (error: unknown) => reportError(error),
  );
}
