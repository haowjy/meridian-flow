// @ts-nocheck
/**
 * Workspace layout UI store for thread-list work grouping.
 *
 * Purpose: persist the small piece of workbench workspace chrome state that is not
 * part of the surface layout model: collapsed work groups in ThreadPanel. Key
 * decision: surface width/collapse prefs moved to the workbench surface prefs
 * store; this store keeps the public hook names stable for existing imports.
 */
import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

export type LayoutState = {
  /** Thread-list work groups the user has collapsed (keyed by `work.id`). */
  collapsedWorkIds: string[];
};

export type LayoutActions = {
  toggleWorkGroupCollapsed: (workId: string) => void;
};

type LayoutSlice = LayoutState & LayoutActions;

export const useLayoutStore = create<LayoutSlice>()(
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
        name: "meridian:layout",
        partialize: (s) => ({
          collapsedWorkIds: s.collapsedWorkIds,
        }),
        // Defer reading localStorage to the client to avoid SSR hydration
        // mismatches — the store renders with defaults on the server, then
        // rehydrates after mount.
        skipHydration: true,
      },
    ),
    { name: "layout-store", enabled: import.meta.env.DEV },
  ),
);

/** Stable selector for layout actions (avoids re-renders on state change). */
export function useLayoutActions(): LayoutActions {
  return useLayoutStore(
    useShallow((s) => ({
      toggleWorkGroupCollapsed: s.toggleWorkGroupCollapsed,
    })),
  );
}
