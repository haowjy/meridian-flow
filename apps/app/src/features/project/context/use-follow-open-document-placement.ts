/**
 * useFollowOpenDocumentPlacement — take main's address to wherever the replica now places its
 * document, and say once that a presented document the replica no longer places was removed. A
 * kept document the replica no longer places is let go without a word.
 *
 * Desktop and phone both need this: main's host derives its document from the address's
 * catalog, so a move that leaves that catalog would otherwise strand it on the old path. The
 * removed document stays where it was shown, in its removed state; nothing closes it.
 */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useEffect, useMemo, useRef } from "react";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import { contextRouteRequest, sameContextTarget } from "../routing/project-route";
import {
  useAccountResourceProjection,
  useContextRemovalCoordinator,
  usePresentedDocuments,
  useProjectContextAvailabilityCoordinator,
  useShownDocuments,
} from "./account-feature-context";
import { routeTargetForTab } from "./context-removal-planner";
import { type ContextRouteSelection, routeSelectionDocumentId } from "./context-removal-protocol";
import { projectResourceTab } from "./open-document-from-file";
import { useIsDraftOnly } from "./use-is-draft-only";

export function useFollowOpenDocumentPlacement(input: {
  projectId: string;
  editorWorkId: string | null | undefined;
  /** A Work's Scratch route: its owning Work. */
  activeContextWork?: string | null;
  /** The route follows a document only while the selection is bound to it at this route. */
  selection: ContextRouteSelection;
  activeContextScheme: ProjectContextTreeScheme | null;
  activeContextPath: string | null;
  activeContextChat?: string | null;
  onOpenContextTarget: OpenContextRoute;
}): void {
  const presented = usePresentedDocuments(input.projectId);
  const shown = useShownDocuments(input.projectId);
  const mounted = useMemo(
    () => [
      ...presented,
      ...shown.filter((tab) => !presented.some((on) => on.documentId === tab.documentId)),
    ],
    [presented, shown],
  );
  const resourceProjection = useAccountResourceProjection(input.projectId);
  const contextRemoval = useContextRemovalCoordinator();
  const availability = useProjectContextAvailabilityCoordinator();
  const isDraftOnly = useIsDraftOnly(input.projectId);
  // A removal is said once per document: the document stays presented in its removed state.
  const removed = useRef(new Set<string>());

  useEffect(() => {
    const route =
      input.editorWorkId && input.activeContextScheme !== null && input.activeContextPath !== null
        ? contextRouteRequest({
            scheme: input.activeContextScheme,
            path: input.activeContextPath,
            workId: input.activeContextWork,
            rootThreadId: input.activeContextChat,
          })
        : null;
    // A review binding owns the draft's path, which the live placement does not show.
    const boundDocumentId =
      route && !(input.selection.status === "bound" && input.selection.by === "review")
        ? routeSelectionDocumentId(input.selection, route)
        : null;
    const gone = new Set<string>();
    for (const tab of mounted) {
      const projection = projectResourceTab(
        tab,
        resourceProjection.records,
        resourceProjection.placement,
        isDraftOnly(tab.documentId),
      );
      if (projection.kind === "none") continue;
      if (projection.kind === "terminal" || projection.kind === "removed") {
        gone.add(tab.documentId);
        if (removed.current.has(tab.documentId)) continue;
        removed.current.add(tab.documentId);
        // closeVanished keeps a document a live draft still holds, and says the rest went.
        contextRemoval.closeVanished(input.projectId, tab);
        if (projection.kind === "terminal")
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
      // A route is the document's only while the selection is bound to it there; a URL the
      // writer just pasted or traversed to is never pulled back to a shown document's placement.
      if (
        route !== null &&
        tab.kind !== "new" &&
        projection.tab.kind !== "new" &&
        boundDocumentId === tab.documentId &&
        !sameContextTarget(routeTargetForTab(projection.tab), route)
      )
        void input
          .onOpenContextTarget(
            contextRouteRequest({ ...projection.tab, documentId: projection.tab.documentId }),
            { replace: true, tab: projection.tab },
          )
          .then(
            (settlement) => {
              if (settlement.kind === "failed") reportError(settlement.error);
            },
            (error: unknown) => reportError(error),
          );
    }
    // A restored document can be removed again later.
    for (const documentId of removed.current)
      if (!gone.has(documentId)) removed.current.delete(documentId);
  }, [
    input.activeContextChat,
    input.activeContextWork,
    input.activeContextPath,
    input.activeContextScheme,
    input.editorWorkId,
    input.onOpenContextTarget,
    input.projectId,
    input.selection,
    availability,
    contextRemoval,
    isDraftOnly,
    resourceProjection.records,
    resourceProjection.placement,
    mounted,
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
