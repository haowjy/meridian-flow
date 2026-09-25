/** Route-owned command channel for project destination commands. */
import { createContext, type ReactNode, useContext, useLayoutEffect, useRef } from "react";
import type { ContextTab } from "@/client/stores";
import type { ScreenKey } from "../shell/screens";
import type { NavigationSettlement, ProjectLeaveGuard } from "./project-navigation";
import type { ContextRouteTarget } from "./project-route";

export type OpenContextOptions = {
  replace?: boolean;
  tab?: ContextTab;
  isCurrent?: () => boolean;
  canCommit?: () => boolean;
};

export type OpenContextRoute = (
  target: ContextRouteTarget,
  options?: OpenContextOptions,
) => Promise<NavigationSettlement>;

const ProjectNavigationContext = createContext<{
  registerLeaveGuard?: (guard: ProjectLeaveGuard) => () => void;
  screen?: ScreenKey;
  open: OpenContextRoute;
  openNewChat?: () => Promise<void>;
  openChatIndex?: () => Promise<void>;
  acceptCreatedChat?: (threadId: string) => void;
  dockChatView?: "chat" | "index";
  dockChatReveal?: number;
  revealDockChat?: () => void;
  recoveringFirstSend?: boolean;
  capture?: () => () => boolean;
} | null>(null);

export function ProjectNavigationProvider({
  children,
  openContextRoute,
  captureNavigation,
  openNewChat,
  openChatIndex,
  acceptCreatedChat,
  dockChatView,
  dockChatReveal,
  revealDockChat,
  recoveringFirstSend,
  screen,
  registerLeaveGuard,
}: {
  screen?: ScreenKey;
  children: ReactNode;
  openContextRoute: OpenContextRoute;
  captureNavigation?: () => () => boolean;
  openNewChat?: () => Promise<void>;
  openChatIndex?: () => Promise<void>;
  acceptCreatedChat?: (threadId: string) => void;
  dockChatView?: "chat" | "index";
  dockChatReveal?: number;
  revealDockChat?: () => void;
  recoveringFirstSend?: boolean;
  registerLeaveGuard?: (guard: ProjectLeaveGuard) => () => void;
}) {
  return (
    <ProjectNavigationContext.Provider
      value={{
        screen,
        open: openContextRoute,
        capture: captureNavigation,
        openNewChat,
        openChatIndex,
        acceptCreatedChat,
        dockChatView,
        dockChatReveal,
        revealDockChat,
        recoveringFirstSend,
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

/** Commands are pane-aware at the route boundary; consumers never write a URL. */
export function useProjectChatNavigation() {
  return useContext(ProjectNavigationContext);
}
