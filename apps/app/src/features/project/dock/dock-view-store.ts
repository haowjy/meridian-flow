/** Session-only view choices and the transient document slot for the project dock. */
import { create } from "zustand";
import type { ContextTab } from "@/client/stores";
import type { ScreenKey } from "../shell/screens";

/** Dock destinations the writer switches between. */
export type DockView = "chat" | "context" | "changes";

/**
 * The one document the dock shows in place of its views, until the writer
 * closes it. Work documents also close on leaving their Work screen. Its
 * project prevents a document appearing in another project. On the Editor
 * screen documents open as tabs instead; a Chat document can stay parked.
 */
export type DockDocument = {
  projectId: string;
  screen: Exclude<ScreenKey, "context">;
  tab: ContextTab;
};

type DockViewSet = {
  /** Ordered segments for the switch. */
  views: readonly DockView[];
  /** Shown when the writer has made no explicit choice this session. */
  default: DockView;
  /** The occupant's native (non-Changes) view — its content stays mounted. */
  primary: DockView;
};

/**
 * The view set is a function of the dock occupant, which the screen fixes:
 * the Chat screen docks the context rail; Work/Editor dock the chat surface.
 */
const DOCK_VIEW_SETS: Record<ScreenKey, DockViewSet> = {
  work: { views: ["chat", "changes"], default: "chat", primary: "chat" },
  chat: { views: ["context", "changes"], default: "context", primary: "context" },
  context: { views: ["chat", "changes"], default: "chat", primary: "chat" },
};

type DockViewState = {
  byScreen: Partial<Record<ScreenKey, DockView>>;
  occupant: DockDocument | null;
  /**
   * Bumps on every new intent: an open requested or made, a close, a view
   * choice, and a move to another project, screen or Work. A slow open claims
   * a revision when it starts and commits only if it is still the latest.
   */
  revision: number;
  /** Where the writer is, as last synced; only a real change counts as an intent. */
  scope: string | null;
  /** The Work on the Work screen (null elsewhere): the Work whose Scratch the dock menu browses. */
  workId: string | null;
  /** The writer picks a view: it replaces an occupant the dock was showing on that screen. */
  setDockView: (screen: ScreenKey, view: DockView) => void;
  /** Start an open: bumps the revision and returns it. Every async dock attempt claims first. */
  claim: () => number;
  /** Whether `claim` is still the latest intent. */
  isCurrent: (claim: number) => boolean;
  /** Show the document if `claim` is still the latest intent; false means it was superseded. */
  commit: (claim: number, document: DockDocument) => boolean;
  closeDocument: () => void;
  /** Fence project changes and departures from a Work; Chat documents can stay parked. */
  syncOccupantScope: (projectId: string, screen: ScreenKey, workId: string | null) => void;
};

export const useDockViewStore = create<DockViewState>((set, get) => {
  const setOccupant = (occupant: DockDocument | null) =>
    set((state) => ({ occupant, revision: state.revision + 1 }));
  return {
    byScreen: {},
    occupant: null,
    revision: 0,
    scope: null,
    workId: null,
    setDockView: (screen, view) =>
      set((state) => ({
        byScreen: { ...state.byScreen, [screen]: view },
        occupant: state.occupant?.screen === screen ? null : state.occupant,
        revision: state.revision + 1,
      })),
    isCurrent: (claim) => get().revision === claim,
    commit: (claim, document) => {
      if (get().revision !== claim) return false;
      setOccupant(document);
      return true;
    },
    claim: () => {
      set((state) => ({ revision: state.revision + 1 }));
      return get().revision;
    },
    closeDocument: () => setOccupant(null),
    syncOccupantScope: (projectId, screen, workId) =>
      set((state) => {
        const scope = `${projectId}\u0000${screen}\u0000${workId ?? ""}`;
        if (scope === state.scope) return state;
        const { occupant } = state;
        // A Work's note belongs to that Work's screen.
        const stays =
          occupant != null &&
          occupant.projectId === projectId &&
          (occupant.screen !== "work" ||
            (screen === "work" && occupant.tab.kind !== "new" && occupant.tab.workId === workId));
        return {
          scope,
          workId: screen === "work" ? workId : null,
          occupant: stays ? occupant : null,
          revision: state.revision + 1,
        };
      }),
  };
});

export type ResolvedDockView = {
  view: DockView;
  views: readonly DockView[];
  primaryView: DockView;
};

/** Resolve the explicit choice or the screen's default. */
export function resolveDockView(screen: ScreenKey, stored: DockView | undefined): ResolvedDockView {
  const set = DOCK_VIEW_SETS[screen];
  const view = stored && set.views.includes(stored) ? stored : set.default;
  return { view, views: set.views, primaryView: set.primary };
}

/** Remove the Changes destination when its model is empty. */
export function withoutEmptyChanges(
  resolved: ResolvedDockView,
  hasChanges: boolean,
): ResolvedDockView {
  if (hasChanges) return resolved;
  return {
    ...resolved,
    view: resolved.view === "changes" ? resolved.primaryView : resolved.view,
    views: resolved.views.filter((view) => view !== "changes"),
  };
}

/** Resolve the active dock view for a screen and bind the switch action. */
export function useDockView(
  screen: ScreenKey,
  projectId: string,
): ResolvedDockView & {
  setView: (view: DockView) => void;
  /** The document replacing the views on this screen, if any. */
  document: DockDocument | null;
} {
  const stored = useDockViewStore((state) => state.byScreen[screen]);
  const setDockView = useDockViewStore((state) => state.setDockView);
  const occupant = useDockDocument(screen, projectId);
  return {
    ...resolveDockView(screen, stored),
    setView: (next) => setDockView(screen, next),
    document: occupant,
  };
}

/** One scope predicate for rendering, highlighting and imperative hand-offs. */
export function dockDocumentOnScreen(
  occupant: DockDocument | null,
  screen: ScreenKey,
  projectId: string,
): DockDocument | null {
  return occupant?.screen === screen && occupant.projectId === projectId ? occupant : null;
}

export function useDockDocument(screen: ScreenKey, projectId: string): DockDocument | null {
  return useDockViewStore((state) => dockDocumentOnScreen(state.occupant, screen, projectId));
}
