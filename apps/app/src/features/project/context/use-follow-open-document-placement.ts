/**
 * useFollowOpenDocumentPlacement — take main's address to wherever the project's lists now place
 * its document (the project's, or the account's `user://`). Removal is not here: the list's
 * observer (`list-removal-observer.ts`) reads Trash and purge.
 *
 * Desktop and phone both need this: main's host derives its document from the address's
 * tree, so a move that leaves that tree would otherwise strand it on the old path.
 */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useEffect, useMemo, useRef } from "react";
import { ownerOfSource, useProjectTrees } from "@/client/query/useProjectTrees";
import type { OpenDocument } from "@/client/stores";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import { contextRouteRequest, sameContextTarget } from "../routing/project-route";
import {
  type useContextRemovalCoordinator,
  usePresentedDocuments,
  useShownDocuments,
} from "./account-feature-context";
import { routeTargetForTab } from "./context-removal-planner";
import { placeTab } from "./open-document-from-file";
import { useIsDraftOnly } from "./use-is-draft-only";

export function useFollowOpenDocumentPlacement(input: {
  projectId: string;
  editorWorkId: string | null | undefined;
  /** A Work's Scratch route: its owning Work. */
  activeContextWork?: string | null;
  /** The address names a review: the draft's path is the address, not the live placement. */
  review: boolean;
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
  const trees = useProjectTrees(input.projectId, { account: true });
  const isDraftOnly = useIsDraftOnly(input.projectId);
  // A move between two lists leaves the document in neither for a moment, and its view goes with
  // it: the places views last showed are kept until the route is no longer at one.
  const lastShown = useRef(new Map<string, OpenDocument>());

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
    for (const tab of mounted) lastShown.current.set(tab.documentId, tab);
    for (const [documentId, tab] of lastShown.current) {
      const spelled =
        route !== null && tab.kind !== "new" && sameContextTarget(routeTargetForTab(tab), route);
      if (!spelled && !mounted.some((on) => on.documentId === documentId)) {
        lastShown.current.delete(documentId);
        continue;
      }
      const found = trees.find(tab.documentId);
      const projection = placeTab(
        found && {
          scheme: found.source.scheme,
          file: found.file,
          owner: ownerOfSource(found.source),
        },
        trees.isComplete,
        isDraftOnly(tab.documentId),
      );
      if (projection.kind === "none" || projection.kind === "removed") continue;
      // The URL is the document's only while it spells the place the view last showed it at; once
      // the address no longer resolves there (a move), main would show nothing, so it follows.
      if (
        route !== null &&
        !input.review &&
        spelled &&
        projection.document.kind !== "new" &&
        !sameContextTarget(routeTargetForTab(projection.document), route)
      )
        void input
          .onOpenContextTarget(
            contextRouteRequest({
              ...projection.document,
              documentId: projection.document.documentId,
            }),
            { replace: true, document: projection.document },
          )
          .then(
            (settlement) => {
              if (settlement.kind === "failed") reportError(settlement.error);
            },
            (error: unknown) => reportError(error),
          );
    }
  }, [
    input.activeContextChat,
    input.activeContextWork,
    input.activeContextPath,
    input.activeContextScheme,
    input.editorWorkId,
    input.onOpenContextTarget,
    input.projectId,
    input.review,
    isDraftOnly,
    trees,
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
