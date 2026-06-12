// @ts-nocheck
/**
 * Independent-chat registry — client-side convention for "workbench-less" chats.
 *
 * Every thread requires a workbench in the backend data model, so an independent
 * chat is really a thread in an auto-created workbench that we keep hidden from
 * the workbench list until the user promotes it ("Create workbench"). This registry
 * tracks which workbench ids are still in that hidden/draft state. It is
 * intentionally client-only and localStorage-backed — no schema change. When
 * the standalone WS scope is adopted backend-side, this registry retires
 * without any UX change.
 */
import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

type IndependentWorkbenchesState = {
  /** Workbench ids representing un-promoted independent chats. */
  ids: string[];
  mark: (id: string) => void;
  /** Promote a draft to a real workbench — removes it from the hidden set. */
  promote: (id: string) => void;
};

export const useIndependentWorkbenchesStore = create<IndependentWorkbenchesState>()(
  devtools(
    persist(
      (set) => ({
        ids: [],
        mark: (id) => set((s) => (s.ids.includes(id) ? s : { ids: [...s.ids, id] })),
        promote: (id) => set((s) => ({ ids: s.ids.filter((x) => x !== id) })),
      }),
      { name: "meridian:independent-workbenches", skipHydration: true },
    ),
    { name: "independent-workbenches", enabled: import.meta.env.DEV },
  ),
);

/** Reactive set of hidden independent-chat workbench ids. */
export function useIndependentWorkbenchIds(): ReadonlySet<string> {
  const ids = useIndependentWorkbenchesStore((s) => s.ids);
  return new Set(ids);
}

export function useIsIndependentWorkbench(id: string): boolean {
  return useIndependentWorkbenchesStore((s) => s.ids.includes(id));
}

/** Imperative helpers for non-React call sites (optimistic flows). */
export function markIndependentWorkbench(id: string): void {
  useIndependentWorkbenchesStore.getState().mark(id);
}

export function promoteIndependentWorkbench(id: string): void {
  useIndependentWorkbenchesStore.getState().promote(id);
}
