/** Platform-neutral project adapter for context removal lifecycle and route identity. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ScreenKey } from "../shell/screens";
import {
  type ContextRemovalRoutePort,
  contextRemovalCoordinator,
} from "./context-removal-coordinator";

export type ProjectContextRemovalControllerProps = {
  projectId: string;
  activeScreen: ScreenKey;
  activeContextScheme: ProjectContextTreeScheme | null;
  activeContextPath: string | null;
  editorWorkId: string | null;
  route: ContextRemovalRoutePort;
  children: React.ReactNode;
};

export function ProjectContextRemovalController({
  projectId,
  activeScreen,
  activeContextScheme,
  activeContextPath,
  editorWorkId,
  route,
  children,
}: ProjectContextRemovalControllerProps) {
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
    const registration = contextRemovalCoordinator.registerRoutePort(
      projectId,
      stableRoute,
      editorWorkId,
    );
    registrationRef.current = registration;
    return () => registration.release();
  }, [projectId, stableRoute]);

  useLayoutEffect(() => {
    if (!registrationRef.current) return;
    if (activeScreen !== "context" || activeContextScheme === null || activeContextPath === null) {
      contextRemovalCoordinator.clearRouteSelection(projectId);
      return;
    }
    contextRemovalCoordinator.beginRouteSelection(projectId, {
      scheme: activeContextScheme,
      path: activeContextPath,
      workId: editorWorkId,
    });
  }, [activeContextPath, activeContextScheme, activeScreen, editorWorkId, projectId]);

  useEffect(() => {
    void contextRemovalCoordinator.pruneWork(projectId, editorWorkId);
  }, [editorWorkId, projectId]);

  return children;
}
