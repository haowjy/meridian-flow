/** dock-view-store — which view the right dock shows, per screen, for the session. */
import { useCallback } from "react";
import { create } from "zustand";
import type { ContextTab } from "@/client/stores";
import { useChatNavigation } from "../routing/chat-navigation";
import type { ScreenKey } from "../shell/screens";

/** Dock destinations. File is transient and only offered while a Work file is open. */
export type DockView = "chat" | "context" | "changes" | "file";

export type DockFileView = { workId: string; tab: Extract<ContextTab, { kind: "viewer" }> };

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
  workFile: DockFileView | null;
  setDockView: (screen: ScreenKey, view: DockView) => void;
  openWorkFile: (file: DockFileView) => void;
  closeWorkFile: () => void;
  enterWork: (workId: string) => void;
  leaveWork: (workId: string) => void;
};

export const useDockViewStore = create<DockViewState>((set) => ({
  byScreen: {},
  workFile: null,
  setDockView: (screen, view) =>
    set((state) => ({ byScreen: { ...state.byScreen, [screen]: view } })),
  openWorkFile: (workFile) =>
    set((state) => ({
      workFile,
      byScreen: { ...state.byScreen, work: "file" },
    })),
  closeWorkFile: () =>
    set((state) => ({
      workFile: null,
      byScreen: { ...state.byScreen, work: "chat" },
    })),
  enterWork: (workId) =>
    set((state) => ({
      workFile: state.workFile?.workId === workId ? state.workFile : null,
    })),
  leaveWork: (workId) =>
    set((state) =>
      state.workFile?.workId === workId
        ? { workFile: null, byScreen: { ...state.byScreen, work: "chat" } }
        : state,
    ),
}));

/** Open one read-only Scratch/Uploads file in the Work dock slot. */
export function useOpenFileInDock(workId: string) {
  const openWorkFile = useDockViewStore((state) => state.openWorkFile);
  const { revealDock } = useChatNavigation();
  return useCallback(
    (tab: Extract<ContextTab, { kind: "viewer" }>) => {
      openWorkFile({ workId, tab });
      revealDock("file");
    },
    [openWorkFile, revealDock, workId],
  );
}

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
  file: DockFileView | null;
  closeFile: () => void;
} {
  const stored = useDockViewStore((state) => state.byScreen[screen]);
  const setDockView = useDockViewStore((state) => state.setDockView);
  const file = useDockViewStore((state) => (screen === "work" ? state.workFile : null));
  const closeFile = useDockViewStore((state) => state.closeWorkFile);
  const resolved = resolveDockView(screen, stored);
  const withFile =
    file && screen === "work"
      ? {
          ...resolved,
          view: (stored === "changes"
            ? "changes"
            : stored === "chat"
              ? "chat"
              : "file") as DockView,
          views: [resolved.views[0], "file" as const, ...resolved.views.slice(1)],
        }
      : resolved;
  return {
    ...withFile,
    setView: (next) => setDockView(screen, next),
    file,
    closeFile,
  };
}
