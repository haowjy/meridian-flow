import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SourceKey = "manuscript" | "kb" | "scratch" | "user" | "trash" | "unfiled" | "changes";

/** Every source the strip can show, in strip order. */
export const ALL_SOURCES: readonly SourceKey[] = [
  "manuscript",
  "kb",
  "scratch",
  "user",
  "trash",
  "unfiled",
  "changes",
];

type SidebarTabs = {
  shown: readonly SourceKey[];
  toggle: (source: SourceKey) => void;
  show: (source: SourceKey) => void;
};

/** Which sources the sidebar's strip shows: the writer's choice, kept on this device. */
export const useSidebarTabs = create<SidebarTabs>()(
  persist(
    (set) => ({
      shown: ALL_SOURCES,
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
    }),
    {
      name: "meridian.sidebar-tabs.v1",
      version: 1,
      partialize: (state) => ({ shown: state.shown }),
      // Rehydrated after mount: the server renders the default strip.
      skipHydration: true,
    },
  ),
);

/** The strip keeps its order whatever order tabs were added in. */
function inStripOrder(shown: readonly SourceKey[]): SourceKey[] {
  return ALL_SOURCES.filter((key) => shown.includes(key));
}
