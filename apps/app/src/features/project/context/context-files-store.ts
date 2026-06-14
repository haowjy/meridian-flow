// @ts-nocheck
/**
 * Context files panel — dedicated device-local preference store.
 *
 * Purpose: own the nested files-panel width + collapsed state, decoupled from
 * the shared project surface-prefs store. This panel is NEVER placed in a
 * grid slot (always slot: null); the files explorer renders inside
 * `ContextViewer`, below the tab strip. Its prefs rode in the shared store by
 * historical accident; now it has its own persistence key and client-rehydration
 * so it doesn't entangle the project shell's hydration gate.
 *
 * Key decision: no separate `_hydrated` gate. The store is consumed only inside
 * `ContextViewer`, which only mounts inside `DesktopProject`, which is ALREADY
 * gated on the project store's `_hydrated`. A second gate would be redundant
 * complexity. The only requirement is that this store is rehydrated (and seeded
 * from legacy) in `_authenticated.tsx` BEFORE the project `setHydrated()` call.
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

/**
 * One-time seed: harvest the legacy `context-files` prefs blob from the old
 * shared project store key and materialize it under the new dedicated key.
 *
 * Idempotent — skips if the new key already exists or if localStorage is
 * unavailable (SSR). Call this BEFORE `useContextFilesPanelStore.persist
 * .rehydrate()` so the subsequent rehydrate reads the freshly seeded value
 * (the persist adapter writes to localStorage on every state change even
 * with skipHydration — it only defers the read).
 */
export function seedContextFilesPanelFromLegacy(): void {
  if (typeof localStorage === "undefined") return;
  // Already migrated or already has its own value — idempotent gate.
  if (localStorage.getItem("meridian:context-files-panel") !== null) return;

  try {
    const raw = localStorage.getItem("meridian:project-surface-layout");
    if (!raw) return;
    const blob = JSON.parse(raw);
    // The legacy blob shape under Zustand persist v4: { state: { prefs: { "context-files": { width, collapsed } } } }
    const legacy = blob?.state?.prefs?.["context-files"];
    if (!legacy) return;

    const { getState } = useContextFilesPanelStore;
    if (typeof legacy.width === "number") {
      getState().setWidth(legacy.width);
    }
    if (typeof legacy.collapsed === "boolean") {
      getState().setCollapsed(legacy.collapsed);
    }
  } catch {
    // Corrupt JSON — silently skip, start with defaults.
  }
}
