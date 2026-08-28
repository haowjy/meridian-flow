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
  const registrationRef = useRef<{ token: symbol; release: () => void } | null>(null);

  useLayoutEffect(() => {
    const registration = coordinator.registerRoutePort(projectId, stableRoute, editorWorkId);
    registrationRef.current = registration;
    return () => registration.release();
  }, [coordinator, projectId, stableRoute]);

  useLayoutEffect(() => {
    if (!registrationRef.current) return;
    if (activeScreen !== "context" || activeContextScheme === null || activeContextPath === null) {
      coordinator.changeWorkSelection(projectId, editorWorkId, null);
      return;
    }
    coordinator.changeWorkSelection(projectId, editorWorkId, {
      scheme: activeContextScheme,
      path: activeContextPath,
      workId: editorWorkId,
    });
  }, [activeContextPath, activeContextScheme, activeScreen, coordinator, editorWorkId, projectId]);

  return null;
}
