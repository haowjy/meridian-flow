/** Session-only view choices and the transient document slot for the project dock. */
import { create } from "zustand";
import type { ProjectResultItem } from "@/client/api/project-results-api";
import type { ServerContextTab } from "@/client/stores";
import type { ScreenKey } from "../shell/screens";

/** Dock destinations the writer switches between. */
export type DockView = "chat" | "context" | "changes";

/**
 * The one document the dock shows, in place of its views, until it is closed
 * or the writer leaves the screen that opened it. The Editor screen never
 * holds one: there, documents open as tabs.
 */
export type DockDocument = { screen: DockDocumentScreen; tab: ServerContextTab };
type DockDocumentScreen = Exclude<ScreenKey, "context">;

/**
 * A Results row opened in the dock's document slot. A result is a promoted
 * artifact read by id, not a project document, so it has no tab or editor; it
 * shares the slot's rules (it covers the views until closed, and only the Chat
 * screen's rail opens one).
 */
export type DockResult = ProjectResultItem;

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
  document: DockDocument | null;
  result: DockResult | null;
  /** The writer picks a view: it replaces a document the dock was showing. */
  setDockView: (screen: ScreenKey, view: DockView) => void;
  openDocument: (document: DockDocument) => void;
  openResult: (result: DockResult) => void;
  /** Closes the slot, whether it holds a document or a result. */
  closeDocument: () => void;
  /** Drop a document that does not belong to where the writer now is. */
  syncDocumentScope: (screen: ScreenKey, workId: string | null) => void;
};

export const useDockViewStore = create<DockViewState>((set) => ({
  byScreen: {},
  document: null,
  result: null,
  setDockView: (screen, view) =>
    set((state) => ({
      byScreen: { ...state.byScreen, [screen]: view },
      document: state.document?.screen === screen ? null : state.document,
      result: screen === "chat" ? null : state.result,
    })),
  openDocument: (document) => set({ document, result: null }),
  openResult: (result) => set({ result, document: null }),
  closeDocument: () => set({ document: null, result: null }),
  syncDocumentScope: (screen, workId) =>
    set((state) => {
      const { document, result } = state;
      const keepResult = screen === "chat" ? result : null;
      if (!document) return keepResult === result ? state : { result: keepResult };
      // A Work's note belongs to that Work's screen.
      const stays =
        document.screen === screen && (screen !== "work" || document.tab.workId === workId);
      return stays ? state : { document: null, result: keepResult };
    }),
}));

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
export function useDockView(screen: ScreenKey): ResolvedDockView & {
  setView: (view: DockView) => void;
  /** The document replacing the views on this screen, if any. */
  document: DockDocument | null;
  /** The result replacing them, if any (the Chat screen only). */
  result: DockResult | null;
  closeDocument: () => void;
} {
  const stored = useDockViewStore((state) => state.byScreen[screen]);
  const setDockView = useDockViewStore((state) => state.setDockView);
  const document = useDockViewStore((state) =>
    state.document?.screen === screen ? state.document : null,
  );
  const result = useDockViewStore((state) => (screen === "chat" ? state.result : null));
  const closeDocument = useDockViewStore((state) => state.closeDocument);
  return {
    ...resolveDockView(screen, stored),
    setView: (next) => setDockView(screen, next),
    document,
    result,
    closeDocument,
  };
}
