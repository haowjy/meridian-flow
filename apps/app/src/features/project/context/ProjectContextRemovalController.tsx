/** Live project removal host; mounted only after Work/bootstrap readiness. */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useLayoutEffect, useMemo, useRef } from "react";
import { useRecentDocuments } from "@/client/query/useRecentDocuments";
import type { AccountRecentItem } from "@/client/recents";
import { useOpenContextRoute } from "../routing/ProjectNavigationContext";
import { contextRouteRequest } from "../routing/project-route";
import { useContextRemovalCoordinator } from "./account-feature-context";
import type { ContextRemovalRoutePort } from "./context-removal-coordinator";
import { selectionAtRoute } from "./context-removal-protocol";
import { useOpenProjectDocument } from "./open-project-document";
import { openRecent } from "./RecentDocumentsLanding";
import { useContextRemovalProject } from "./use-context-removal-project";

export type ProjectContextRemovalControllerProps = {
  projectId: string;
  activeContextScheme: ProjectContextTreeScheme | null;
  activeContextPath: string | null;
  /** A chat's Scratch route names its lineage here. */
  activeContextChat?: string | null;
  /** The Work scope: the project's active Work. */
  editorWorkId: string;
  /** A Work's Scratch route names its owning Work here. */
  activeContextWork?: string | null;
  localDocumentId?: string;
  /** A review address names its document by item: that id is proof, so the route starts bound. */
  reviewDocumentId?: string;
  route: Omit<ContextRemovalRoutePort, "goBack">;
};

export function ProjectContextRemovalController({
  projectId,
  activeContextScheme,
  activeContextPath,
  activeContextChat,
  editorWorkId,
  activeContextWork,
  localDocumentId,
  reviewDocumentId,
  route,
}: ProjectContextRemovalControllerProps) {
  const coordinator = useContextRemovalCoordinator();
  const recent = useRecentDocuments(projectId);
  const openDocument = useOpenProjectDocument(projectId);
  const openRoute = useOpenContextRoute();
  const latest = useRef({ route, recent: recent.documents, openDocument, openRoute, editorWorkId });
  latest.current = { route, recent: recent.documents, openDocument, openRoute, editorWorkId };
  const stableRoute = useMemo<ContextRemovalRoutePort>(
    () => ({
      transition: (projectId, target, prepared) =>
        latest.current.route.transition(projectId, target, prepared),
      readSearch: (registeredProjectId) => latest.current.route.readSearch(registeredProjectId),
      updateSearch: (registeredProjectId, update, relocated) =>
        latest.current.route.updateSearch(registeredProjectId, update, relocated),
      goBack: (projectId, documentId, removing, isCurrent) => {
        const { recent, ...ports } = latest.current;
        const toRecents = () =>
          ports.route.transition(
            projectId,
            { kind: "clear" },
            { isCurrent, commit: () => undefined },
          );
        const before = shownBefore(recent, documentId, removing);
        void (before ? openRecent(before, { projectId, ...ports }, true) : Promise.resolve(false))
          .then((opened) => (opened || !isCurrent() ? undefined : toRecents()))
          .then(
            (settlement) => {
              if (settlement?.kind === "failed") reportError(settlement.error);
            },
            (error: unknown) => reportError(error),
          );
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    const registration = coordinator.registerRoutePort(projectId, stableRoute, editorWorkId);
    return () => registration.release();
  }, [coordinator, projectId, stableRoute]);

  // A scope pick moves no route: a document's owner is its own, never the scope.
  useLayoutEffect(() => {
    coordinator.setActiveWork(projectId, editorWorkId);
  }, [coordinator, projectId, editorWorkId]);

  // A navigation's binding can land after the address was already repaired elsewhere: a selection
  // about another route than the URL begins again here.
  const { selection } = useContextRemovalProject(projectId);
  const selectionStale =
    selection.status !== "none" &&
    (activeContextScheme === null ||
      activeContextPath === null ||
      !selectionAtRoute(selection, {
        scheme: activeContextScheme,
        path: activeContextPath,
        workId: activeContextWork ?? undefined,
        rootThreadId: activeContextChat ?? undefined,
      }));
  const previousLocalDocument = useRef(localDocumentId);
  useLayoutEffect(() => {
    const locator =
      activeContextScheme !== null && activeContextPath !== null
        ? contextRouteRequest({
            scheme: activeContextScheme,
            path: activeContextPath,
            workId: activeContextWork,
            rootThreadId: activeContextChat,
          })
        : null;
    if (previousLocalDocument.current !== localDocumentId) {
      previousLocalDocument.current = localDocumentId;
      coordinator.clearRouteSelection(projectId);
    }
    if (locator && reviewDocumentId)
      coordinator.enterRoute(projectId, locator, reviewDocumentId, "review");
    else if (locator) coordinator.beginRouteSelection(projectId, locator);
    else coordinator.clearRouteSelection(projectId);
  }, [
    activeContextChat,
    activeContextPath,
    activeContextScheme,
    coordinator,
    activeContextWork,
    projectId,
    localDocumentId,
    reviewDocumentId,
    selectionStale,
  ]);

  return null;
}

/**
 * Recently opened is main's opening history, newest first: the document main showed before
 * `documentId` is the next entry after it that stays. One main never recorded (a draft-only
 * page) was shown after them all, so the first entry that stays is the one before it.
 */
function shownBefore(
  recent: readonly AccountRecentItem[],
  documentId: string,
  removing: readonly string[],
): AccountRecentItem | null {
  const at = recent.findIndex((item) => item.documentId === documentId);
  return (
    recent
      .slice(at + 1)
      .find((item) => item.documentId !== documentId && !removing.includes(item.documentId)) ?? null
  );
}
