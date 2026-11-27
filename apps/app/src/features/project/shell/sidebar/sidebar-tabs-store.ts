import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TreeTab = "manuscript" | "kb" | "user" | "agents";

export const TREE_TABS: readonly TreeTab[] = ["manuscript", "kb", "user", "agents"];

const DEFAULT_TREE_TABS: readonly TreeTab[] = ["manuscript", "kb"];

type SidebarTabs = {
  shown: readonly TreeTab[];
  toggle: (source: TreeTab) => void;
  show: (source: TreeTab) => void;
  asked: { source: AskedSource } | null;
  reveal: (source: AskedSource) => void;
  settle: () => void;
};

export type AskedSource = TreeTab | "changes";

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

function inStripOrder(shown: readonly unknown[]): TreeTab[] {
  return TREE_TABS.filter((key) => shown.includes(key));
}
