/** Route-owned command channel for project destination commands. */
import { createContext, type ReactNode, useContext, useLayoutEffect, useRef } from "react";
import type { ContextTab } from "@/client/stores";
import type { ScreenKey } from "../shell/screens";
import type { RunDocumentSwitch } from "./document-switch-failure";
import type { NavigationSettlement, ProjectLeaveGuard } from "./project-navigation";
import type { ContextRouteRequest, ContextRouteTarget } from "./project-route";

export type OpenContextOptions = {
  replace?: boolean;
  /** Replace only when the route already names this document; otherwise push. */
  replaceIfSameDocument?: boolean;
  tab?: ContextTab;
  /** The destination is accepted, before its workspace commit. */
  onAccepted?: () => void;
  /** Slot hand-off after the destination tab is installed. */
  onCommitted?: () => void;
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
  runDocumentSwitch?: RunDocumentSwitch;
  railSwitchFailed?: ScreenKey | null;
  capture?: () => () => boolean;
  isCurrentContextRoute?: (target: ContextRouteTarget) => boolean;
} | null>(null);

export function ProjectNavigationProvider({
  children,
  openContextRoute,
  captureNavigation,
  isCurrentContextRoute,
  screen,
  registerLeaveGuard,
  runDocumentSwitch,
  railSwitchFailed,
}: {
  screen?: ScreenKey;
  children: ReactNode;
  openContextRoute: OpenContextRoute;
  runDocumentSwitch?: RunDocumentSwitch;
  railSwitchFailed?: ScreenKey | null;
  captureNavigation?: () => () => boolean;
  isCurrentContextRoute?: (target: ContextRouteTarget) => boolean;
  registerLeaveGuard?: (guard: ProjectLeaveGuard) => () => void;
}) {
  return (
    <ProjectNavigationContext.Provider
      value={{
        screen,
        open: openContextRoute,
        capture: captureNavigation,
        isCurrentContextRoute,
        registerLeaveGuard,
        runDocumentSwitch,
        railSwitchFailed,
      }}
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

/** Opt-in presentation for the dock header; ordinary document opens keep their own policy. */
export function useRunDocumentSwitch() {
  return useContext(ProjectNavigationContext)?.runDocumentSwitch;
}

export function useRailSwitchFailed() {
  return useContext(ProjectNavigationContext)?.railSwitchFailed ?? null;
}
