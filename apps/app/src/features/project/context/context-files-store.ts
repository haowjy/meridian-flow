/**
 * Context files panel — dedicated device-local preference store.
 *
 * Purpose: own the nested files-panel width + collapsed state. This panel is
 * NEVER placed in a grid slot (always slot: null); the files explorer renders
 * inside `ContextViewer`, below the tab strip. Dedicated persistence keeps it
 * independent from the project shell's surface prefs and hydration gate.
 *
 * Key decision: no separate `_hydrated` gate. The store is consumed only inside
 * `ContextViewer`, which only mounts inside `DesktopProject`, which is ALREADY
 * gated on the project store's `_hydrated`. A second gate would be redundant
 * complexity. The only requirement is that this store is rehydrated in
 * `_authenticated.tsx` before the project `setHydrated()` call.
 */
import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const CONTEXT_FILES_WIDTH_BOUNDS = { min: 160, max: 360 } as const;

type ContextFilesPanelState = {
  width: number;
  collapsed: boolean;
};

type ContextFilesPanelActions = {
  setWidth: (px: number) => void;
  setCollapsed: (collapsed: boolean) => void;
};

export type ContextFilesPanelStore = ReturnType<typeof createContextFilesPanelStore>;

function createContextFilesPanelStore() {
  return create<ContextFilesPanelState & ContextFilesPanelActions>()(
    devtools(
      persist(
        (set) => ({
          width: 220,
          collapsed: false,

          setWidth: (px) =>
            set({
              width: clamp(px, CONTEXT_FILES_WIDTH_BOUNDS.min, CONTEXT_FILES_WIDTH_BOUNDS.max),
            }),
          setCollapsed: (collapsed) => set({ collapsed }),
        }),
        {
          name: "meridian:context-files-panel",
          partialize: (state) => ({ width: state.width, collapsed: state.collapsed }),
          // skipHydration matches the app's SSR-safe pattern — rehydration is
          // triggered explicitly in _authenticated.tsx.
          skipHydration: true,
        },
      ),
      { name: "context-files-panel", enabled: import.meta.env.DEV },
    ),
  );
}

export const useContextFilesPanelStore = createContextFilesPanelStore();

/** Stable selector for context files panel actions (avoids re-renders on state changes). */
export function useContextFilesPanelActions() {
  return useContextFilesPanelStore(
    useShallow((state) => ({
      setWidth: state.setWidth,
      setCollapsed: state.setCollapsed,
    })),
  );
}

/**
 * Convenience selector returning `{ width, collapsed }` — the two values
 * `ContextViewer` reads on every render.
 */
export function useContextFilesPanel() {
  return useContextFilesPanelStore(
    useShallow((state) => ({ width: state.width, collapsed: state.collapsed })),
  );
}
