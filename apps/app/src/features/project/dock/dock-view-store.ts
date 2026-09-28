/** Session-only view choices and transient Work file state for the project dock. */
import { t } from "@lingui/core/macro";
import { useCallback } from "react";
import { create } from "zustand";
import type { ContextTab } from "@/client/stores";
import { useChatNavigation } from "../routing/chat-navigation";
import type { ScreenKey } from "../shell/screens";

/** Dock destinations. File is transient and only offered while a Work file is open. */
export type DockView = "chat" | "context" | "changes" | "file";
type StoredDockView = Exclude<DockView, "file">;

export type DockFile = { workId: string; tab: Extract<ContextTab, { kind: "viewer" }> };
type DockFileSlot = DockFile & { active: boolean };

type DockViewSet = {
  /** Ordered segments for the switch. */
  views: readonly StoredDockView[];
  /** Shown when the writer has made no explicit choice this session. */
  default: StoredDockView;
  /** The occupant's native (non-Changes) view — its content stays mounted. */
  primary: StoredDockView;
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
  /** Writer-selected non-file view only. A transient file never replaces this choice. */
  byScreen: Partial<Record<ScreenKey, StoredDockView>>;
  workFile: DockFileSlot | null;
  setDockView: (screen: ScreenKey, view: DockView) => void;
  openWorkFile: (file: DockFile) => void;
  closeWorkFile: () => void;
  enterWork: (workId: string) => void;
  leaveWork: () => void;
};

export const useDockViewStore = create<DockViewState>((set) => ({
  byScreen: {},
  workFile: null,
  setDockView: (screen, view) =>
    set((state) => {
      if (view === "file") {
        if (screen !== "work" || !state.workFile || state.workFile.active) return state;
        return { workFile: { ...state.workFile, active: true } };
      }
      const next = {
        byScreen: { ...state.byScreen, [screen]: view },
      };
      if (screen !== "work" || !state.workFile?.active) return next;
      return { ...next, workFile: { ...state.workFile, active: false } };
    }),
  openWorkFile: (file) => set({ workFile: { ...file, active: true } }),
  closeWorkFile: () => set({ workFile: null }),
  enterWork: (workId) =>
    set((state) => {
      if (!state.workFile || state.workFile.workId === workId) return state;
      return { workFile: null };
    }),
  leaveWork: () => set((state) => (state.workFile ? { workFile: null } : state)),
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

/** Resolve the explicit choice/default and include the transient file segment when present. */
export function resolveDockView(
  screen: ScreenKey,
  stored: StoredDockView | undefined,
  hasFile: boolean,
): ResolvedDockView {
  const set = DOCK_VIEW_SETS[screen];
  const explicit = stored && set.views.includes(stored) ? stored : set.default;
  const views =
    hasFile && screen === "work"
      ? [set.views[0], "file" as const, ...set.views.slice(1)]
      : set.views;
  return { view: explicit, views, primaryView: set.primary };
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
  file: DockFile | null;
  closeFile: () => void;
} {
  const stored = useDockViewStore((state) => state.byScreen[screen]);
  const setDockView = useDockViewStore((state) => state.setDockView);
  const workFile = useDockViewStore((state) => (screen === "work" ? state.workFile : null));
  const closeFile = useDockViewStore((state) => state.closeWorkFile);
  const resolved = resolveDockView(screen, stored, workFile !== null);
  return {
    ...resolved,
    view: workFile?.active ? "file" : resolved.view,
    setView: (next) => setDockView(screen, next),
    file: workFile,
    closeFile,
  };
}

/** Localized location chrome for a Scratch or Uploads file in the dock. */
export function dockFileLocation(tab: DockFile["tab"]): { name: string; folder?: string } {
  const folders = tab.path.split("/").filter(Boolean).slice(0, -1);
  return {
    name: tab.scheme === "scratch" ? t`Scratch` : t`Uploads`,
    ...(folders.length > 0 ? { folder: folders.join(", ") } : {}),
  };
}
