/** Live project removal host; mounted only after Work/bootstrap readiness. */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useLayoutEffect, useMemo, useRef } from "react";
import { contextRouteRequest } from "../routing/project-route";
import type { ScreenKey } from "../shell/screens";
import { useContextRemovalCoordinator } from "./account-feature-context";
import type { ContextRemovalRoutePort } from "./context-removal-coordinator";
import { selectionAtRoute } from "./context-removal-protocol";
import { useContextRemovalProject } from "./use-context-removal-project";

export type ProjectContextRemovalControllerProps = {
  projectId: string;
  activeScreen: ScreenKey;
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
  route: ContextRemovalRoutePort;
};

export function ProjectContextRemovalController({
  projectId,
  activeScreen,
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
  const latestRouteRef = useRef(route);
  latestRouteRef.current = route;
  const stableRoute = useMemo<ContextRemovalRoutePort>(
    () => ({
      transition: (projectId, target, prepared) =>
        latestRouteRef.current.transition(projectId, target, prepared),
      readSearch: (registeredProjectId) => latestRouteRef.current.readSearch(registeredProjectId),
      updateSearch: (registeredProjectId, update, relocated) =>
        latestRouteRef.current.updateSearch(registeredProjectId, update, relocated),
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
      activeScreen === "context" && activeContextScheme !== null && activeContextPath !== null
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
    activeScreen,
    coordinator,
    activeContextWork,
    projectId,
    localDocumentId,
    reviewDocumentId,
    selectionStale,
  ]);

  return null;
}
