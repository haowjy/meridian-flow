/** Route-owned command channel for project destination commands. */
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { OpenDocument } from "@/client/stores";
import type { NavigationSettlement } from "./project-navigation";
import type { ContextRouteRequest } from "./project-route";

/**
 * The chat an open was made from. It rides on the history entry the open pushes, so that entry
 * keeps the chat beside the document it opened, Back included.
 */
export type BesideHint = { chatId: string };

/** The history-state key the beside hint is stored under. */
export const BESIDE_STATE_KEY = "meridianBeside";

/** The beside hint a history entry's state carries, if any. */
export function besideHintOf(state: object): BesideHint | null {
  const value = (state as Record<string, unknown>)[BESIDE_STATE_KEY];
  if (!value || typeof value !== "object") return null;
  const chatId = (value as { chatId?: unknown }).chatId;
  return typeof chatId === "string" && chatId.length > 0 ? { chatId } : null;
}

export type OpenContextOptions = {
  replace?: boolean;
  /** Replace only when the route already names this document; otherwise push. */
  replaceIfSameDocument?: boolean;
  tab?: OpenDocument;
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
  /** The chat the open was made from (`OpenedFromChat`). */
  beside?: BesideHint;
};

export type OpenContextRoute = (
  target: ContextRouteRequest,
  options?: OpenContextOptions,
) => Promise<NavigationSettlement>;

const ProjectNavigationContext = createContext<{
  open: OpenContextRoute;
  capture?: () => () => boolean;
  trash: {
    destination: true | string | undefined;
    navigate: (
      destination: false | true | string,
      options?: { replace?: boolean },
    ) => Promise<unknown>;
  };
} | null>(null);

export function ProjectNavigationProvider({
  children,
  openContextRoute,
  captureNavigation,
  trash,
}: {
  children: ReactNode;
  openContextRoute: OpenContextRoute;
  captureNavigation?: () => () => boolean;
  trash: {
    destination: true | string | undefined;
    navigate: (
      destination: false | true | string,
      options?: { replace?: boolean },
    ) => Promise<unknown>;
  };
}) {
  return (
    <ProjectNavigationContext.Provider
      value={{
        open: openContextRoute,
        capture: captureNavigation,
        trash,
      }}
    >
      {children}
    </ProjectNavigationContext.Provider>
  );
}

const OpenedFromChatContext = createContext<BesideHint | null>(null);

/** Every open made inside this chat carries it as the new entry's beside hint. */
export function OpenedFromChat({
  chatId,
  children,
}: {
  chatId: string | null;
  children: ReactNode;
}) {
  const hint = useMemo(() => (chatId ? { chatId } : null), [chatId]);
  return <OpenedFromChatContext.Provider value={hint}>{children}</OpenedFromChatContext.Provider>;
}

/** The chat the surrounding UI is inside, if any (`OpenedFromChat`). */
export function useOpenedFromChat(): BesideHint | null {
  return useContext(OpenedFromChatContext);
}

export function useOpenContextRoute(): OpenContextRoute | null {
  const open = useContext(ProjectNavigationContext)?.open ?? null;
  const beside = useOpenedFromChat();
  return useMemo(
    () =>
      open && beside
        ? (target: ContextRouteRequest, options?: OpenContextOptions) =>
            open(target, { beside, ...options })
        : open,
    [open, beside],
  );
}

/** Capture before an asynchronous create; completion must not steal a later destination. */
export function useCaptureProjectNavigation() {
  return useContext(ProjectNavigationContext)?.capture;
}

/** The route-owned Trash overlay destination and its one navigation operation. */
export function useProjectTrashNavigation() {
  const trash = useContext(ProjectNavigationContext)?.trash;
  if (!trash) throw new Error("Project Trash navigation is required");
  return trash;
}
