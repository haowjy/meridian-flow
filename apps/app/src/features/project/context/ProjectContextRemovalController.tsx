/** Live project removal host; mounted only after Work/bootstrap readiness. */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { ScreenKey } from "../shell/screens";
import { useContextRemovalCoordinator } from "./ContextRemovalAccountProvider";
import type { ContextRemovalRoutePort } from "./context-removal-coordinator";

export type ProjectContextRemovalControllerProps = {
  projectId: string;
  activeScreen: ScreenKey;
  activeContextScheme: ProjectContextTreeScheme | null;
  activeContextPath: string | null;
  editorWorkId: string;
  route: ContextRemovalRoutePort;
};

export function ProjectContextRemovalController({
  projectId,
  activeScreen,
  activeContextScheme,
  activeContextPath,
  editorWorkId,
  route,
}: ProjectContextRemovalControllerProps) {
  const coordinator = useContextRemovalCoordinator();
  const latestRouteRef = useRef(route);
  latestRouteRef.current = route;
  const stableRoute = useMemo<ContextRemovalRoutePort>(
    () => ({
      readSearch: (registeredProjectId) => latestRouteRef.current.readSearch(registeredProjectId),
      updateSearch: (registeredProjectId, update) =>
        latestRouteRef.current.updateSearch(registeredProjectId, update),
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

  useLayoutEffect(() => {
    const registration = registrationRef.current;
    if (!registration) return;
    const locator =
      activeScreen === "context" && activeContextScheme !== null && activeContextPath !== null
        ? { scheme: activeContextScheme, path: activeContextPath, workId: editorWorkId }
        : null;
    if (registration.editorWorkId !== editorWorkId) {
      coordinator.changeWorkSelection(projectId, editorWorkId, locator);
      registration.editorWorkId = editorWorkId;
      return;
    }
    if (locator) coordinator.beginRouteSelection(projectId, locator);
    else coordinator.clearRouteSelection(projectId);
  }, [activeContextPath, activeContextScheme, activeScreen, coordinator, editorWorkId, projectId]);

  return null;
}
