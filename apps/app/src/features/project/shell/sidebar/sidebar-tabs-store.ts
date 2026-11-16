import { create } from "zustand";
import { persist } from "zustand/middleware";

/** A tree source the writer can put in the middle of the strip, between Chat and Changes. */
export type TreeTab = "manuscript" | "kb" | "user" | "agents";

/** Every tree source the ⋯ menu offers, in strip order. */
export const TREE_TABS: readonly TreeTab[] = ["manuscript", "kb", "user", "agents"];

const DEFAULT_TREE_TABS: readonly TreeTab[] = ["manuscript", "kb"];

type SidebarTabs = {
  shown: readonly TreeTab[];
  toggle: (source: TreeTab) => void;
  show: (source: TreeTab) => void;
  /**
   * An ask from outside the sidebar to put a pane on screen: the shell opens the sidebar (the
   * phone's drawer), and the sidebar shows the pane and settles the ask.
   */
  asked: { source: AskedSource } | null;
  /** Shows the pane on screen, a tree tab in the strip too ("Manage Agents", the chat strip's "more"). */
  reveal: (source: AskedSource) => void;
  settle: () => void;
};

export type AskedSource = TreeTab | "changes";

/** Which tree sources the sidebar's strip shows: the writer's choice, kept on this device. */
export const useSidebarTabs = create<SidebarTabs>()(
  persist(
    (set) => ({
      shown: DEFAULT_TREE_TABS,
      toggle: (source) =>
        set((state) => ({
          shown: state.shown.includes(source)
            ? state.shown.filter((key) => key !== source)
            : inStripOrder([...state.shown, source]),
        })),
      show: (source) =>
        set((state) =>
          state.shown.includes(source) ? state : { shown: inStripOrder([...state.shown, source]) },
        ),
      asked: null,
      reveal: (source) =>
        set((state) => ({
          shown:
            source === "changes" || state.shown.includes(source)
              ? state.shown
              : inStripOrder([...state.shown, source]),
          asked: { source },
        })),
      settle: () => set({ asked: null }),
    }),
    {
      name: "meridian.sidebar-tabs.v1",
      version: 2,
      partialize: (state) => ({ shown: state.shown }),
      // Version 1 chose every tab; Scratch, Trash, Unfiled and Changes have left the strip.
      migrate: (persisted) => {
        const stored = (persisted as { shown?: unknown } | null)?.shown;
        const kept = Array.isArray(stored) ? inStripOrder(stored) : [];
        return { shown: kept.length > 0 ? kept : DEFAULT_TREE_TABS };
      },
      // Rehydrated after mount: the server renders the default strip.
      skipHydration: true,
    },
  ),
);

/** The strip keeps its order whatever order tabs were added in. */
function inStripOrder(shown: readonly unknown[]): TreeTab[] {
  return TREE_TABS.filter((key) => shown.includes(key));
}
