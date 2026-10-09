/** The project dock's views per screen, and the Work page's transient file view. */
import { t } from "@lingui/core/macro";
import { create } from "zustand";
import type { ContextTab } from "@/client/stores";
import type { ScreenKey } from "../shell/screens";

/** Dock destinations: the occupant's own view, and the Work page's transient File. */
export type DockView = "chat" | "context" | "file";

export type DockFile = { workId: string; tab: Extract<ContextTab, { kind: "viewer" }> };
type DockFileSlot = DockFile & { active: boolean };

/**
 * What the dock holds is a function of the screen: the Chat screen docks the
 * context rail; Work and Editor dock the chat surface. The occupant is the dock's
 * only view, except on Work, where a Scratch or Uploads file opened from the page
 * adds a second one (`file`), so the switch exists only then.
 */
const DOCK_OCCUPANT: Record<ScreenKey, Exclude<DockView, "file">> = {
  work: "chat",
  chat: "context",
  context: "chat",
};

type DockViewState = {
  /** Work only: the transient file, and whether it is the view on show. */
  workFile: DockFileSlot | null;
  /** `file` shows the Work's transient file; any other view returns to the occupant. */
  setDockView: (screen: ScreenKey, view: DockView) => void;
  openWorkFile: (file: DockFile) => void;
  closeWorkFile: () => void;
  enterWork: (workId: string) => void;
  leaveWork: () => void;
};

/** Session-only: a fresh reload starts on the occupant. */
export const useDockViewStore = create<DockViewState>((set) => ({
  workFile: null,
  setDockView: (screen, view) =>
    set((state) => {
      if (screen !== "work" || !state.workFile) return state;
      if (view === "file")
        return state.workFile.active ? state : { workFile: { ...state.workFile, active: true } };
      return state.workFile.active ? { workFile: { ...state.workFile, active: false } } : state;
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

export type ResolvedDockView = {
  view: DockView;
  /** The switch's segments: the occupant, then the transient file when there is one. */
  views: readonly DockView[];
};

/** The dock's views for a screen, and the one on show when no file is. */
export function resolveDockView(screen: ScreenKey, hasFile: boolean): ResolvedDockView {
  const occupant = DOCK_OCCUPANT[screen];
  return {
    view: occupant,
    views: hasFile && screen === "work" ? [occupant, "file"] : [occupant],
  };
}

/** Resolve the active dock view for a screen and bind the switch action. */
export function useDockView(screen: ScreenKey): ResolvedDockView & {
  setView: (view: DockView) => void;
  file: DockFile | null;
  closeFile: () => void;
} {
  const setDockView = useDockViewStore((state) => state.setDockView);
  const workFile = useDockViewStore((state) => (screen === "work" ? state.workFile : null));
  const closeFile = useDockViewStore((state) => state.closeWorkFile);
  const resolved = resolveDockView(screen, workFile !== null);
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
