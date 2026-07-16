/**
 * dock-view-store — which view the right dock shows, per screen, for the session.
 *
 * Purpose: the dock is a tabbed container whose view set depends on which
 * surface occupies it (chat vs the context rail), plus a shared work-scoped
 * Changes view. This store remembers the writer's last *explicit* choice per
 * screen so switching destinations and coming back restores the view they left.
 *
 * Key decision: session-only, no `persist`. The default per screen is the
 * occupant's native view (Context on the chat screen, Chat elsewhere); a fresh
 * reload starts from those defaults rather than a stale view. Placement, width,
 * and collapse stay owned by the surface-prefs store — this store only tracks
 * the view.
 */
import { create } from "zustand";

import type { ScreenKey } from "../shell/screens";

/** The three dock views. Which two are offered depends on the screen. */
export type DockView = "chat" | "context" | "changes";

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
 * the chat screen docks the context rail; Home/Context dock the chat surface.
 */
const DOCK_VIEW_SETS: Record<ScreenKey, DockViewSet> = {
  home: { views: ["chat", "changes"], default: "chat", primary: "chat" },
  chat: { views: ["context", "changes"], default: "context", primary: "context" },
  context: { views: ["chat", "changes"], default: "chat", primary: "chat" },
};

type DockViewState = {
  byScreen: Partial<Record<ScreenKey, DockView>>;
  setDockView: (screen: ScreenKey, view: DockView) => void;
};

export const useDockViewStore = create<DockViewState>((set) => ({
  byScreen: {},
  setDockView: (screen, view) =>
    set((state) => ({ byScreen: { ...state.byScreen, [screen]: view } })),
}));

export type ResolvedDockView = {
  view: DockView;
  views: readonly DockView[];
  primaryView: DockView;
};

/**
 * Pure resolution: the active view is the writer's stored choice when it is
 * still valid for this screen's set, otherwise the screen's default. Kept
 * separate from the hook so the fallback contract is unit-testable.
 */
export function resolveDockView(screen: ScreenKey, stored: DockView | undefined): ResolvedDockView {
  const set = DOCK_VIEW_SETS[screen];
  const view = stored && set.views.includes(stored) ? stored : set.default;
  return { view, views: set.views, primaryView: set.primary };
}

/** Resolve the active dock view for a screen and bind the switch action. */
export function useDockView(screen: ScreenKey): ResolvedDockView & {
  setView: (view: DockView) => void;
} {
  const stored = useDockViewStore((state) => state.byScreen[screen]);
  const setDockView = useDockViewStore((state) => state.setDockView);
  return {
    ...resolveDockView(screen, stored),
    setView: (next) => setDockView(screen, next),
  };
}
