/** Route-owned command channel for project destination commands. */
import { createContext, type ReactNode, useContext } from "react";
import type { OpenDocument } from "@/client/stores";
import type { NavigationSettlement } from "./project-navigation";
import type { ContextRouteRequest, ProjectRouteCommands } from "./project-route";

export type OpenContextOptions = {
  replace?: boolean;
  /** Replace only when the route already names this document; otherwise push. */
  replaceIfSameDocument?: boolean;
  document?: OpenDocument;
  /** Live lacks the document: its draft created it, or live deleted it while the draft keeps it. */
  draftOnly?: boolean;
  /** The destination is a document the writer just made: its editor takes the caret once live. */
  focus?: true;
  /** Runs only once the navigation committed. */
  afterCommit?: () => void;
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

/** Main's deleted document: the one the address names, and the command that shows one. */
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

/** The route's own commands (Recently opened), for a control outside main's header. */
export function useProjectRouteCommands(): ProjectRouteCommands {
  const commands = useContext(ProjectNavigationContext)?.routeCommands;
  if (!commands) throw new Error("Project route commands are required");
  return commands;
}
