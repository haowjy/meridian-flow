/** dock-view-store — which view the right dock shows, per screen, for the session. */
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
 * the Chat screen docks the context rail; Work/Editor dock the chat surface.
 */
const DOCK_VIEW_SETS: Record<ScreenKey, DockViewSet> = {
  work: { views: ["chat", "changes"], default: "chat", primary: "chat" },
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
