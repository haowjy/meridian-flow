import { createContext, type ReactNode, useContext } from "react";
import type { OpenDocument } from "@/client/stores";
import type { ReviewTarget } from "./project-address";
import type { NavigationSettlement } from "./project-navigation";
import type { ContextRouteRequest, ProjectRouteCommands } from "./project-route";

export type OpenContextOptions = {
  replace?: boolean;
  replaceIfSameDocument?: boolean;
  document?: OpenDocument;
  draftOnly?: boolean;
  focus?: true;
  afterCommit?: () => void;
  itemKey?: string;
  review?: ReviewTarget;
  changeId?: string;
  isCurrent?: () => boolean;
  canCommit?: () => boolean;
};

export type OpenContextRoute = (
  target: ContextRouteRequest,
  options?: OpenContextOptions,
) => Promise<NavigationSettlement>;

export type TrashNavigation = {
  shown: string | undefined;
  open: (documentId: string, options?: { replace?: boolean }) => Promise<unknown>;
};

const ProjectNavigationContext = createContext<{
  open: OpenContextRoute;
  capture?: () => () => boolean;
  trash: TrashNavigation;
  routeCommands: ProjectRouteCommands;
} | null>(null);

export function ProjectNavigationProvider({
  children,
  openContextRoute,
  captureNavigation,
  trash,
  routeCommands,
}: {
  children: ReactNode;
  openContextRoute: OpenContextRoute;
  captureNavigation?: () => () => boolean;
  trash: TrashNavigation;
  routeCommands: ProjectRouteCommands;
}) {
  return (
    <ProjectNavigationContext.Provider
      value={{
        open: openContextRoute,
        capture: captureNavigation,
        trash,
        routeCommands,
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

export function useTrashNavigation(): TrashNavigation {
  const trash = useContext(ProjectNavigationContext)?.trash;
  if (!trash) throw new Error("Project Trash navigation is required");
  return trash;
}

export function useProjectRouteCommands(): ProjectRouteCommands {
  const commands = useContext(ProjectNavigationContext)?.routeCommands;
  if (!commands) throw new Error("Project route commands are required");
  return commands;
}
