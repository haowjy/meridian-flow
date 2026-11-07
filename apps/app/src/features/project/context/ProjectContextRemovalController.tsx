/** Live project removal host; mounted only after Work/bootstrap readiness. */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useLayoutEffect, useMemo, useRef } from "react";
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
  editorWorkId: string;
  localDocumentId?: string;
  route: ContextRemovalRoutePort;
};

export function ProjectContextRemovalController({
  projectId,
  activeScreen,
  activeContextScheme,
  activeContextPath,
  activeContextChat,
  editorWorkId,
  localDocumentId,
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
  const registrationRef = useRef<{
    token: symbol;
    release: () => void;
    editorWorkId: string;
  } | null>(null);

  useLayoutEffect(() => {
    const registration = coordinator.registerRoutePort(projectId, stableRoute, editorWorkId);
    registrationRef.current = { ...registration, editorWorkId };
    return () => registration.release();
  }, [coordinator, projectId, stableRoute]);

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
        workId: editorWorkId,
        rootThreadId: activeContextChat ?? undefined,
      }));
  const previousLocalDocument = useRef(localDocumentId);
  useLayoutEffect(() => {
    const registration = registrationRef.current;
    if (!registration) return;
    const locator =
      activeScreen === "context" && activeContextScheme !== null && activeContextPath !== null
        ? {
            scheme: activeContextScheme,
            path: activeContextPath,
            workId: editorWorkId,
            ...(activeContextChat ? { rootThreadId: activeContextChat } : {}),
          }
        : null;
    if (registration.editorWorkId !== editorWorkId) {
      coordinator.changeWorkSelection(projectId, editorWorkId, locator);
      registration.editorWorkId = editorWorkId;
      return;
    }
    if (previousLocalDocument.current !== localDocumentId) {
      previousLocalDocument.current = localDocumentId;
      coordinator.clearRouteSelection(projectId);
    }
    if (locator) coordinator.beginRouteSelection(projectId, locator);
    else coordinator.clearRouteSelection(projectId);
  }, [
    activeContextChat,
    activeContextPath,
    activeContextScheme,
    activeScreen,
    coordinator,
    editorWorkId,
    projectId,
    localDocumentId,
    selectionStale,
  ]);

  return null;
}
