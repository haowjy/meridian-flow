/**
 * Device-local project surface preference store.
 *
 * Purpose: persist user chrome preferences for stateful surfaces AND for the
 * shared right-dock slot. Surface prefs are keyed by stable surface identity
 * (last committed width + collapsed). The dock slot also has its own
 * width/collapsed pref so that whichever surface currently occupies the dock
 * (chat on home/context screens, context-rail on chat screen) reads/writes a
 * single shared width and collapse state — the dock reads as one persistent
 * sidebar across screens, only its inner content swaps.
 *
 * Key decision: slot placement is not stored here because it is a pure function
 * of the active screen; the placement module merges these prefs into a
 * render-time SurfaceLayoutMap, overlaying the shared dock pref onto whichever
 * surface lands in the dock slot.
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import {
  type DesktopProjectSlotId,
  PROJECT_SURFACE_IDS,
  type SurfaceId,
  type SurfacePrefs,
  type SurfacePrefsMap,
} from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type SurfaceWidthBounds = Partial<Record<SurfaceId, { min: number; max: number }>>;

export type SlotWidthBounds = Partial<Record<DesktopProjectSlotId, { min: number; max: number }>>;

export const DEFAULT_SURFACE_PREFS: SurfacePrefsMap = {
  threads: { width: 264, collapsed: false },
  chat: { width: 360, collapsed: false },
  "context-viewer": { width: 0, collapsed: true },
  "context-rail": { width: 320, collapsed: true },
};

/** Shared right-dock pref. Seeded from chat's previous width on first run. */
export const DEFAULT_DOCK_PREFS: SurfacePrefs = { width: 360, collapsed: false };

export const SURFACE_WIDTH_BOUNDS: SurfaceWidthBounds = {
  threads: { min: 220, max: 380 },
  chat: { min: 280, max: 520 },
  "context-rail": { min: 240, max: 480 },
};

/** One bounds entry per slot whose width is persisted at slot level. */
export const SLOT_WIDTH_BOUNDS: SlotWidthBounds = {
  dock: { min: 240, max: 520 },
};

type PersistedSurfacePrefsMap = Partial<Record<SurfaceId, Partial<SurfacePrefs>>>;

type PersistedSlotPrefsMap = Partial<Record<DesktopProjectSlotId, Partial<SurfacePrefs>>>;

type PersistedSurfacePrefsBlob = {
  prefs?: PersistedSurfacePrefsMap | null;
  slotPrefs?: PersistedSlotPrefsMap | null;
};

export type SlotPrefsMap = { dock: SurfacePrefs };

export type SurfacePrefsState = {
  prefs: SurfacePrefsMap;
  slotPrefs: SlotPrefsMap;
};

export type SurfacePrefsActions = {
  setSurfaceWidth: (id: SurfaceId, widthPx: number) => void;
  setSurfaceCollapsed: (id: SurfaceId, collapsed: boolean) => void;
  setDockWidth: (widthPx: number) => void;
  setDockCollapsed: (collapsed: boolean) => void;
  setHydrated: () => void;
};

type SurfacePrefsSlice = SurfacePrefsState &
  SurfacePrefsActions & {
    _hydrated: boolean;
  };

type SurfacePrefsPersistApi = {
  persist: {
    rehydrate: () => Promise<void> | void;
  };
};

export type SurfacePrefsStore = UseBoundStore<StoreApi<SurfacePrefsSlice> & SurfacePrefsPersistApi>;

function patchPrefs(
  prefs: SurfacePrefsMap,
  id: SurfaceId,
  patch: Partial<SurfacePrefsMap[SurfaceId]>,
): SurfacePrefsMap {
  const current = prefs[id] ?? DEFAULT_SURFACE_PREFS[id];
  const nextWidth = patch.width ?? current.width;
  const bounds = SURFACE_WIDTH_BOUNDS[id];
  const width = bounds ? clamp(nextWidth, bounds.min, bounds.max) : nextWidth;
  return {
    ...prefs,
    [id]: {
      ...current,
      ...patch,
      width,
    },
  };
}

function patchDockPrefs(slotPrefs: SlotPrefsMap, patch: Partial<SurfacePrefs>): SlotPrefsMap {
  const current = slotPrefs.dock ?? DEFAULT_DOCK_PREFS;
  const nextWidth = patch.width ?? current.width;
  const bounds = SLOT_WIDTH_BOUNDS.dock;
  const width = bounds ? clamp(nextWidth, bounds.min, bounds.max) : nextWidth;
  return {
    ...slotPrefs,
    dock: { ...current, ...patch, width },
  };
}

export function normalizeSurfacePrefs(prefs?: PersistedSurfacePrefsMap | null): SurfacePrefsMap {
  const normalized = {} as SurfacePrefsMap;
  for (const id of PROJECT_SURFACE_IDS) {
    const defaults = DEFAULT_SURFACE_PREFS[id];
    const persisted = prefs?.[id];
    normalized[id] = {
      width: persisted?.width ?? defaults.width,
      collapsed: persisted?.collapsed ?? defaults.collapsed,
    };
  }
  return normalized;
}

export function normalizeSlotPrefs(slotPrefs?: PersistedSlotPrefsMap | null): SlotPrefsMap {
  const persistedDock = slotPrefs?.dock;
  return {
    dock: {
      width: persistedDock?.width ?? DEFAULT_DOCK_PREFS.width,
      collapsed: persistedDock?.collapsed ?? DEFAULT_DOCK_PREFS.collapsed,
    },
  };
}

export const useProjectSurfacePrefsStore: SurfacePrefsStore = create<SurfacePrefsSlice>()(
  devtools(
    persist(
      (set) => ({
        prefs: DEFAULT_SURFACE_PREFS,
        slotPrefs: { dock: DEFAULT_DOCK_PREFS },
        _hydrated: false,

        setSurfaceWidth: (id, width) =>
          set((state) => ({ prefs: patchPrefs(state.prefs, id, { width }) })),
        setSurfaceCollapsed: (id, collapsed) =>
          set((state) => ({ prefs: patchPrefs(state.prefs, id, { collapsed }) })),
        setDockWidth: (width) =>
          set((state) => ({ slotPrefs: patchDockPrefs(state.slotPrefs, { width }) })),
        setDockCollapsed: (collapsed) =>
          set((state) => ({ slotPrefs: patchDockPrefs(state.slotPrefs, { collapsed }) })),
        setHydrated: () => set({ _hydrated: true }),
      }),
      {
        name: "meridian:project-surface-layout",
        version: 3,
        merge: (persisted, current) => {
          const blob = (persisted as PersistedSurfacePrefsBlob | null) ?? {};
          return {
            ...current,
            prefs: normalizeSurfacePrefs(blob.prefs),
            slotPrefs: normalizeSlotPrefs(blob.slotPrefs),
          };
        },
        partialize: (state) => ({ prefs: state.prefs, slotPrefs: state.slotPrefs }),
        skipHydration: true,
      },
    ),
    { name: "project-surface-layout", enabled: import.meta.env.DEV },
  ),
);

/** Stable selector for surface preference actions (avoids re-renders on state changes). */
export function useProjectSurfacePrefsActions(): SurfacePrefsActions {
  return useProjectSurfacePrefsStore(
    useShallow((state) => ({
      setSurfaceWidth: state.setSurfaceWidth,
      setSurfaceCollapsed: state.setSurfaceCollapsed,
      setDockWidth: state.setDockWidth,
      setDockCollapsed: state.setDockCollapsed,
      setHydrated: state.setHydrated,
    })),
  );
}
