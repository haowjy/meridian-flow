// @ts-nocheck
/**
 * Independent-chat registry — client-side convention for "project-less" chats.
 *
 * Every thread requires a project in the backend data model, so an independent
 * chat is really a thread in an auto-created project that we keep hidden from
 * the project list until the user promotes it ("Create project"). This registry
 * tracks which project ids are still in that hidden/draft state. It is
 * intentionally client-only and localStorage-backed — no schema change. When
 * the standalone WS scope is adopted backend-side, this registry retires
 * without any UX change.
 */
import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

type IndependentProjectsState = {
  /** Project ids representing un-promoted independent chats. */
  ids: string[];
  mark: (id: string) => void;
  /** Promote a draft to a real project — removes it from the hidden set. */
  promote: (id: string) => void;
};

export const useIndependentProjectsStore = create<IndependentProjectsState>()(
  devtools(
    persist(
      (set) => ({
        ids: [],
        mark: (id) => set((s) => (s.ids.includes(id) ? s : { ids: [...s.ids, id] })),
        promote: (id) => set((s) => ({ ids: s.ids.filter((x) => x !== id) })),
      }),
      { name: "meridian:independent-projects", skipHydration: true },
    ),
    { name: "independent-projects", enabled: import.meta.env.DEV },
  ),
);

/** Reactive set of hidden independent-chat project ids. */
export function useIndependentProjectIds(): ReadonlySet<string> {
  const ids = useIndependentProjectsStore((s) => s.ids);
  return new Set(ids);
}

export function useIsIndependentProject(id: string): boolean {
  return useIndependentProjectsStore((s) => s.ids.includes(id));
}

/** Imperative helpers for non-React call sites (optimistic flows). */
export function markIndependentProject(id: string): void {
  useIndependentProjectsStore.getState().mark(id);
}

export function promoteIndependentProject(id: string): void {
  useIndependentProjectsStore.getState().promote(id);
}
