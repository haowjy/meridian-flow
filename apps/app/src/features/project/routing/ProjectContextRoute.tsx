/** Route-owned command channel for atomic context destination opens. */
import { createContext, type ReactNode, useContext } from "react";
import type { ContextRouteTarget } from "./project-route";

export type OpenContextRoute = (
  target: ContextRouteTarget,
  options?: { replace?: boolean },
) => Promise<void>;

const ProjectContextRouteContext = createContext<OpenContextRoute | null>(null);

export function ProjectContextRouteProvider({
  children,
  openContextRoute,
}: {
  children: ReactNode;
  openContextRoute: OpenContextRoute;
}) {
  return (
    <ProjectContextRouteContext.Provider value={openContextRoute}>
      {children}
    </ProjectContextRouteContext.Provider>
  );
}

export function useProjectContextRoute(): OpenContextRoute | null {
  return useContext(ProjectContextRouteContext);
}
