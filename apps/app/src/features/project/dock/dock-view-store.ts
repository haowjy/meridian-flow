/** Session-only view choices and the transient document slot for the project dock. */
import { create } from "zustand";
import type { ProjectResultItem } from "@/client/api/project-results-api";
import type { ServerContextTab } from "@/client/stores";
import type { ScreenKey } from "../shell/screens";

/** Dock destinations the writer switches between. */
export type DockView = "chat" | "context" | "changes";

/**
 * The one thing the dock shows in place of its views, until it is closed or the
 * writer leaves what opened it: a document in the standard editor, or a Results
 * row in a viewer (a result is a promoted artifact read by id, with no tab or
 * editor). It carries its project, so another project's occupant is never shown.
 * The Editor screen never holds one: there, documents open as tabs.
 */
export type DockOccupant =
  | { kind: "document"; projectId: string; screen: DockOccupantScreen; tab: ServerContextTab }
  | { kind: "result"; projectId: string; screen: "chat"; result: ProjectResultItem };
export type DockDocument = Extract<DockOccupant, { kind: "document" }>;
export type DockResult = Extract<DockOccupant, { kind: "result" }>;
type DockOccupantScreen = Exclude<ScreenKey, "context">;

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
  occupant: DockOccupant | null;
  /**
   * Bumps on every occupant change (open, replace, close, scope clear). A slow
   * open reads it before it starts and commits only if it is unchanged.
   */
  revision: number;
  /** The writer picks a view: it replaces an occupant the dock was showing on that screen. */
  setDockView: (screen: ScreenKey, view: DockView) => void;
  open: (occupant: DockOccupant) => void;
  closeDocument: () => void;
  /** Drop an occupant that does not belong to where the writer now is. */
  syncOccupantScope: (projectId: string, screen: ScreenKey, workId: string | null) => void;
};

export const useDockViewStore = create<DockViewState>((set) => {
  const setOccupant = (occupant: DockOccupant | null) =>
    set((state) => ({ occupant, revision: state.revision + 1 }));
  return {
    byScreen: {},
    occupant: null,
    revision: 0,
    setDockView: (screen, view) =>
      set((state) => {
        const cleared = state.occupant?.screen === screen;
        return {
          byScreen: { ...state.byScreen, [screen]: view },
          ...(cleared ? { occupant: null, revision: state.revision + 1 } : {}),
        };
      }),
    open: setOccupant,
    closeDocument: () => setOccupant(null),
    syncOccupantScope: (projectId, screen, workId) =>
      set((state) => {
        const { occupant } = state;
        if (!occupant) return state;
        // A Work's note belongs to that Work's screen.
        const stays =
          occupant.projectId === projectId &&
          occupant.screen === screen &&
          (screen !== "work" || (occupant.kind === "document" && occupant.tab.workId === workId));
        return stays ? state : { occupant: null, revision: state.revision + 1 };
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
  /** The result replacing them, if any (the Chat screen only). */
  result: DockResult | null;
  closeDocument: () => void;
} {
  const stored = useDockViewStore((state) => state.byScreen[screen]);
  const setDockView = useDockViewStore((state) => state.setDockView);
  const occupant = useDockViewStore((state) =>
    state.occupant?.screen === screen && state.occupant.projectId === projectId
      ? state.occupant
      : null,
  );
  const closeDocument = useDockViewStore((state) => state.closeDocument);
  return {
    ...resolveDockView(screen, stored),
    setView: (next) => setDockView(screen, next),
    document: occupant?.kind === "document" ? occupant : null,
    result: occupant?.kind === "result" ? occupant : null,
    closeDocument,
  };
}
