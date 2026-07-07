/**
 * Collapsed works UI store for thread-list work grouping.
 *
 * Purpose: persist the small piece of project workspace chrome state that is not
 * part of the surface layout model: collapsed work groups in ThreadPanel. Key
 * decision: surface width/collapse prefs live in the project surface prefs
 * store; this store owns only the collapsed work-group ids.
 */
import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

export type CollapsedWorksState = {
  /** Thread-list work groups the user has collapsed (keyed by `work.id`). */
  collapsedWorkIds: string[];
};

export type CollapsedWorksActions = {
  toggleWorkGroupCollapsed: (workId: string) => void;
};

type CollapsedWorksSlice = CollapsedWorksState & CollapsedWorksActions;

export const useCollapsedWorksStore = create<CollapsedWorksSlice>()(
  devtools(
    persist(
      (set) => ({
        collapsedWorkIds: [],

        toggleWorkGroupCollapsed: (workId) =>
          set((s) => ({
            collapsedWorkIds: s.collapsedWorkIds.includes(workId)
              ? s.collapsedWorkIds.filter((id) => id !== workId)
              : [...s.collapsedWorkIds, workId],
          })),
      }),
      {
        name: "meridian:collapsed-works",
        partialize: (s) => ({
          collapsedWorkIds: s.collapsedWorkIds,
        }),
        // Defer reading localStorage to the client to avoid SSR hydration
        // mismatches — the store renders with defaults on the server, then
        // rehydrates after mount.
        skipHydration: true,
      },
    ),
    { name: "collapsed-works-store", enabled: import.meta.env.DEV },
  ),
);

/** Stable selector for collapsed-works actions (avoids re-renders on state change). */
export function useCollapsedWorksActions(): CollapsedWorksActions {
  return useCollapsedWorksStore(
    useShallow((s) => ({
      toggleWorkGroupCollapsed: s.toggleWorkGroupCollapsed,
    })),
  );
}
