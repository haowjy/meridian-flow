/** Route-owned command channel for project destination commands. */
import { createContext, type ReactNode, useContext, useLayoutEffect, useRef } from "react";
import type { ContextTab } from "@/client/stores";
import type { ScreenKey } from "../shell/screens";
import type { NavigationSettlement, ProjectLeaveGuard } from "./project-navigation";
import type {
  ContextRouteRequest,
  ContextRouteTarget,
  ProjectRouteCommands,
} from "./project-route";

export type OpenContextOptions = {
  replace?: boolean;
  /** Replace only when the route already names this document; otherwise push. */
  replaceIfSameDocument?: boolean;
  tab?: ContextTab;
  /** Persist an inline review in this Editor history entry. Omission opens live. */
  draftId?: string;
  isCurrent?: () => boolean;
  canCommit?: () => boolean;
};

export type OpenContextRoute = (
  target: ContextRouteRequest,
  options?: OpenContextOptions,
) => Promise<NavigationSettlement>;

const ProjectNavigationContext = createContext<{
  registerLeaveGuard?: (guard: ProjectLeaveGuard) => () => void;
  screen?: ScreenKey;
  open: OpenContextRoute;
  openWork?: ProjectRouteCommands["openWork"];
  capture?: () => () => boolean;
  isCurrentContextRoute?: (target: ContextRouteTarget) => boolean;
} | null>(null);

export function ProjectNavigationProvider({
  children,
  openContextRoute,
  openWork,
  captureNavigation,
  isCurrentContextRoute,
  screen,
  registerLeaveGuard,
}: {
  screen?: ScreenKey;
  children: ReactNode;
  openContextRoute: OpenContextRoute;
  openWork?: ProjectRouteCommands["openWork"];
  captureNavigation?: () => () => boolean;
  isCurrentContextRoute?: (target: ContextRouteTarget) => boolean;
  registerLeaveGuard?: (guard: ProjectLeaveGuard) => () => void;
}) {
  return (
    <ProjectNavigationContext.Provider
      value={{
        screen,
        open: openContextRoute,
        openWork,
        capture: captureNavigation,
        isCurrentContextRoute,
        registerLeaveGuard,
      }}
    >
      {children}
    </ProjectNavigationContext.Provider>
  );
}

export function useOpenContextRoute(): OpenContextRoute | null {
  return useContext(ProjectNavigationContext)?.open ?? null;
}

/** Opens a Work's page (one route transition); null outside a project route. */
export function useOpenWork(): ProjectRouteCommands["openWork"] | null {
  return useContext(ProjectNavigationContext)?.openWork ?? null;
}

/** Capture before an asynchronous create; completion must not steal a later destination. */
export function useCaptureProjectNavigation() {
  return useContext(ProjectNavigationContext)?.capture;
}

/** Whether the browser still shows a specific readable Editor destination. */
export function useIsCurrentContextRoute() {
  return useContext(ProjectNavigationContext)?.isCurrentContextRoute;
}

export function useProjectScreen(): ScreenKey {
  const screen = useContext(ProjectNavigationContext)?.screen;
  if (!screen) throw new Error("Project screen navigation is required");
  return screen;
}

/** Keep one registered decision owner while its metadata state changes. */
export function useProjectLeaveGuard(guard: ProjectLeaveGuard) {
  const register = useContext(ProjectNavigationContext)?.registerLeaveGuard;
  const latest = useRef(guard);
  latest.current = guard;
  useLayoutEffect(
    () =>
      register?.({
        request: (intent) => latest.current.request(intent),
        dirty: () => latest.current.dirty(),
        cancel: () => latest.current.cancel(),
      }),
    [register],
  );
}
