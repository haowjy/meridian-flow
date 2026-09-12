/** Route-owned command channel for project destination commands. */
import { createContext, type ReactNode, useContext } from "react";
import type { ScreenKey } from "../shell/screens";
import type { ContextRouteTarget } from "./project-route";

export type OpenContextRoute = (
  target: ContextRouteTarget,
  options?: { replace?: boolean },
) => Promise<void>;

const ProjectNavigationContext = createContext<{
  screen?: ScreenKey;
  open: OpenContextRoute;
  openNewChat?: () => Promise<void>;
  capture?: () => () => boolean;
} | null>(null);

export function ProjectNavigationProvider({
  children,
  openContextRoute,
  captureNavigation,
  openNewChat,
  screen,
}: {
  screen?: ScreenKey;
  children: ReactNode;
  openContextRoute: OpenContextRoute;
  captureNavigation?: () => () => boolean;
  openNewChat?: () => Promise<void>;
}) {
  return (
    <ProjectNavigationContext.Provider
      value={{ screen, open: openContextRoute, capture: captureNavigation, openNewChat }}
    >
      {children}
    </ProjectNavigationContext.Provider>
  );
}

export function useOpenContextRoute(): OpenContextRoute | null {
  return useContext(ProjectNavigationContext)?.open ?? null;
}

/** Capture before an asynchronous create; completion must not steal a later destination. */
export function useCaptureProjectNavigation() {
  return useContext(ProjectNavigationContext)?.capture;
}

export function useOpenNewChatRoute() {
  return useContext(ProjectNavigationContext)?.openNewChat;
}

export function useProjectScreen(): ScreenKey {
  const screen = useContext(ProjectNavigationContext)?.screen;
  if (!screen) throw new Error("Project screen navigation is required");
  return screen;
}
