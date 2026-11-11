/** Route-owned command channel for project destination commands. */
import { createContext, type ReactNode, useContext, useLayoutEffect, useRef } from "react";
import type { ContextTab } from "@/client/stores";
import type { NavigationSettlement, ProjectLeaveGuard } from "./project-navigation";
import type { ContextRouteRequest, ScreenKey } from "./project-route";

export type OpenContextOptions = {
  replace?: boolean;
  /** Replace only when the route already names this document; otherwise push. */
  replaceIfSameDocument?: boolean;
  tab?: ContextTab;
  /** Live lacks the document: its draft created it, or live deleted it while the draft keeps it. */
  draftOnly?: boolean;
  /** The destination is a document the writer just made: its editor takes the caret once live. */
  focus?: true;
  /** Runs only after successful destination workspace installation. */
  afterCommit?: (installed: ContextTab | undefined) => void;
  /** Persist an inline review in this Editor history entry. Omission opens live. */
  itemKey?: string;
  /** Whose draft `itemKey` reviews (`work:<id>` or `lineage:<root>`); omitted, the Editor's Work. */
  reviewOwner?: string;
  changeId?: string;
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
  screenCommands?: ScreenCommands;
  isCurrentNavigation?: (ticket: import("./project-navigation").ProjectNavigationTicket) => boolean;
  capture?: () => () => boolean;
  trash: {
    destination: true | string | undefined;
    navigate: (
      destination: false | true | string,
      options?: { replace?: boolean },
    ) => Promise<unknown>;
  };
  isCurrentContextRoute?: (target: ContextRouteRequest) => boolean;
} | null>(null);

export function ProjectNavigationProvider({
  children,
  openContextRoute,
  captureNavigation,
  trash,
  isCurrentContextRoute,
  screen,
  registerLeaveGuard,
  screenCommands,
  isCurrentNavigation,
}: {
  screen?: ScreenKey;
  children: ReactNode;
  openContextRoute: OpenContextRoute;
  screenCommands?: ScreenCommands;
  isCurrentNavigation?: (ticket: import("./project-navigation").ProjectNavigationTicket) => boolean;
  captureNavigation?: () => () => boolean;
  trash: {
    destination: true | string | undefined;
    navigate: (
      destination: false | true | string,
      options?: { replace?: boolean },
    ) => Promise<unknown>;
  };
  isCurrentContextRoute?: (target: ContextRouteRequest) => boolean;
  registerLeaveGuard?: (guard: ProjectLeaveGuard) => () => void;
}) {
  return (
    <ProjectNavigationContext.Provider
      value={{
        screen,
        open: openContextRoute,
        capture: captureNavigation,
        trash,
        isCurrentContextRoute,
        registerLeaveGuard,
        screenCommands,
        isCurrentNavigation,
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

export type ScreenCommands = {
  showEditor: (options?: { afterCommit?: () => void }) => Promise<NavigationSettlement>;
};
export function useScreenCommands() {
  return useContext(ProjectNavigationContext)?.screenCommands;
}
export function useIsCurrentNavigation() {
  return useContext(ProjectNavigationContext)?.isCurrentNavigation;
}

export function useProjectScreen(): ScreenKey {
  const screen = useContext(ProjectNavigationContext)?.screen;
  if (!screen) throw new Error("Project screen navigation is required");
  return screen;
}

/** The route-owned Trash overlay destination and its one navigation operation. */
export function useProjectTrashNavigation() {
  const trash = useContext(ProjectNavigationContext)?.trash;
  if (!trash) throw new Error("Project Trash navigation is required");
  return trash;
}
