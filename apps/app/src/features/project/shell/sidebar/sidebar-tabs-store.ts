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

const DEFAULT_SHOWN: readonly SourceKey[] = [
  "manuscript",
  "kb",
  "scratch",
  "user",
  "trash",
  "changes",
];

type SidebarTabs = {
  shown: readonly SourceKey[];
  toggle: (source: SourceKey) => void;
};

/** Which sources the sidebar's strip shows: the writer's choice, kept on this device. */
export const useSidebarTabs = create<SidebarTabs>()(
  persist(
    (set) => ({
      shown: DEFAULT_SHOWN,
      toggle: (source) =>
        set((state) => {
          const shown = state.shown.includes(source)
            ? state.shown.filter((key) => key !== source)
            : [...state.shown, source];
          // The strip keeps its order whatever order tabs were added in.
          return { shown: ALL_SOURCES.filter((key) => shown.includes(key)) };
        }),
    }),
    {
      name: "meridian.sidebar-tabs.v1",
      // v1 strips could include Chats, which now lives in Chat mode's sidebar; strips before v3
      // predate Changes, so they gain it.
      version: 3,
      migrate: (stored, version) => {
        const shown = (stored as { shown?: readonly string[] }).shown ?? [];
        const kept = ALL_SOURCES.filter((key) => shown.includes(key));
        // A strip that was only Chats still needs a list to show.
        if (kept.length === 0) return { shown: DEFAULT_SHOWN };
        return { shown: version < 3 ? [...kept, "changes"] : kept };
      },
      partialize: (state) => ({ shown: state.shown }),
      // Rehydrated after mount: the server renders the default strip.
      skipHydration: true,
    },
  ),
);
