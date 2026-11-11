/**
 * Device-local project chrome preferences.
 *
 * Widths belong to slots (the left rail and the side), so whatever surface sits in
 * a slot reads one width. Whether the sidebar and the side panel are open is one
 * choice for the device, whatever main shows. Placement is not stored here: it follows the kind
 * of item the address names.
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { createJSONStorage, devtools, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import type { PanelSlotId } from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type SlotWidths = Record<PanelSlotId, number>;
/** Whether the left sidebar and the side panel (slot id `dock`) are open. */
export type PanelPrefs = { sidebarOpen: boolean; sideOpen: boolean };

export const SLOT_WIDTH_BOUNDS: Record<PanelSlotId, { min: number; max: number }> = {
  "rail-l": { min: 220, max: 380 },
  // Below this the side header's title and Open in main and rename input compress into slivers.
  dock: { min: 280, max: 520 },
};

export const DEFAULT_SLOT_WIDTHS: SlotWidths = { "rail-l": 264, dock: 360 };

export const DEFAULT_PANEL_PREFS: PanelPrefs = { sidebarOpen: true, sideOpen: true };

function savedWidth(slot: PanelSlotId, width: unknown): number {
  if (typeof width !== "number" || !Number.isFinite(width)) return DEFAULT_SLOT_WIDTHS[slot];
  const bounds = SLOT_WIDTH_BOUNDS[slot];
  return clamp(Math.round(width), bounds.min, bounds.max);
}

export function normalizeSlotWidths(widths?: Partial<SlotWidths> | null): SlotWidths {
  return {
    "rail-l": savedWidth("rail-l", widths?.["rail-l"]),
    dock: savedWidth("dock", widths?.dock),
  };
}

export function normalizePanelPrefs(panels?: Partial<PanelPrefs> | null): PanelPrefs {
  return {
    sidebarOpen:
      typeof panels?.sidebarOpen === "boolean"
        ? panels.sidebarOpen
        : DEFAULT_PANEL_PREFS.sidebarOpen,
    sideOpen:
      typeof panels?.sideOpen === "boolean" ? panels.sideOpen : DEFAULT_PANEL_PREFS.sideOpen,
  };
}

type PersistedSurfacePrefsBlob = {
  widths?: Partial<SlotWidths> | null;
  panels?: Partial<PanelPrefs> | null;
  railPrefs?: Partial<RailPrefs> | null;
  documentPrefs?: Partial<DocumentPrefs> | null;
};

type Saved = Record<string, unknown>;
const record = (value: unknown): Saved =>
  value && typeof value === "object" ? (value as Saved) : {};

/**
 * Version 4 (`main`) kept a width and collapsed flag per surface and for the dock slot;
 * version 5 kept open/closed per mode, which maps only where every mode agrees. What
 * does not map is left out and `merge` fills it with its default.
 */
function migrateSurfacePrefs(persisted: unknown, version: number): PersistedSurfacePrefsBlob {
  const blob = record(persisted);
  const kept = {
    railPrefs: record(blob.railPrefs),
    documentPrefs: record(blob.documentPrefs),
  };
  if (version === 4) {
    const threads = record(record(blob.prefs).threads);
    const dock = record(record(blob.slotPrefs).dock);
    const open = (collapsed: unknown) => (typeof collapsed === "boolean" ? !collapsed : undefined);
    return {
      ...kept,
      widths: { "rail-l": threads.width as number, dock: dock.width as number },
      panels: { sidebarOpen: open(threads.collapsed), sideOpen: open(dock.collapsed) },
    };
  }
  if (version === 5) {
    const modes = Object.values(record(blob.modes)).map(record);
    const agreed = (key: string) => {
      const values = new Set(modes.map((mode) => mode[key]));
      const [only] = values;
      return values.size === 1 && typeof only === "boolean" ? only : undefined;
    };
    return {
      ...kept,
      widths: record(blob.widths),
      panels: { sidebarOpen: agreed("railOpen"), sideOpen: agreed("dockOpen") },
    };
  }
  return {};
}

/** How an open document's chrome is set; shared across documents on this device. */
export type DocumentPrefs = { propertiesOpen: boolean };
export const DEFAULT_DOCUMENT_PREFS: DocumentPrefs = { propertiesOpen: false };

export function normalizeDocumentPrefs(prefs?: Partial<DocumentPrefs> | null): DocumentPrefs {
  return {
    propertiesOpen:
      typeof prefs?.propertiesOpen === "boolean"
        ? prefs.propertiesOpen
        : DEFAULT_DOCUMENT_PREFS.propertiesOpen,
  };
}

export type RailSectionId = "scratch";
/** The rail sections docked under a list, each trading height with it. */
export type DockedRailSectionId = "scratch";
export type RailPrefs = {
  scratchExpanded: boolean;
  scratchHeight: number | null;
};
export const DEFAULT_RAIL_PREFS: RailPrefs = {
  scratchExpanded: false,
  scratchHeight: null,
};

function savedHeight(height: unknown): number | null {
  return typeof height === "number" && Number.isFinite(height) && height > 0
    ? Math.round(height)
    : null;
}

export function normalizeRailPrefs(prefs?: Partial<RailPrefs> | null): RailPrefs {
  return {
    scratchExpanded: typeof prefs?.scratchExpanded === "boolean" ? prefs.scratchExpanded : false,
    scratchHeight: savedHeight(prefs?.scratchHeight),
  };
}

export type SurfacePrefsState = {
  widths: SlotWidths;
  panels: PanelPrefs;
  railPrefs: RailPrefs;
  documentPrefs: DocumentPrefs;
};

export type SurfacePrefsActions = {
  setSlotWidth: (slot: PanelSlotId, widthPx: number) => void;
  setSlotOpen: (slot: PanelSlotId, open: boolean) => void;
  setRailExpanded: (id: RailSectionId, expanded: boolean) => void;
  setRailHeight: (id: DockedRailSectionId, height: number | null) => void;
  setPropertiesOpen: (open: boolean) => void;
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

function openKey(slot: PanelSlotId): keyof PanelPrefs {
  return slot === "rail-l" ? "sidebarOpen" : "sideOpen";
}

export const useProjectSurfacePrefsStore: SurfacePrefsStore = create<SurfacePrefsSlice>()(
  devtools(
    persist(
      (set) => ({
        widths: DEFAULT_SLOT_WIDTHS,
        panels: DEFAULT_PANEL_PREFS,
        railPrefs: DEFAULT_RAIL_PREFS,
        documentPrefs: DEFAULT_DOCUMENT_PREFS,
        _hydrated: false,

        setSlotWidth: (slot, width) =>
          set((state) => ({ widths: { ...state.widths, [slot]: savedWidth(slot, width) } })),
        setSlotOpen: (slot, open) =>
          set((state) => ({ panels: { ...state.panels, [openKey(slot)]: open } })),
        setRailExpanded: (id, expanded) =>
          set((state) => ({ railPrefs: { ...state.railPrefs, [`${id}Expanded`]: expanded } })),
        setRailHeight: (id, height) =>
          set((state) => ({
            railPrefs: normalizeRailPrefs({ ...state.railPrefs, [`${id}Height`]: height }),
          })),
        setPropertiesOpen: (propertiesOpen) =>
          set((state) => ({ documentPrefs: { ...state.documentPrefs, propertiesOpen } })),
        setHydrated: () => set({ _hydrated: true }),
      }),
      {
        name: "meridian:project-surface-layout",
        version: 6,
        migrate: migrateSurfacePrefs,
        storage: createJSONStorage(() => ({
          getItem: (key) => {
            try {
              return window.localStorage.getItem(key);
            } catch {
              return null;
            }
          },
          setItem: (key, value) => {
            try {
              window.localStorage.setItem(key, value);
            } catch {
              /* Layout remains usable in memory. */
            }
          },
          removeItem: (key) => {
            try {
              window.localStorage.removeItem(key);
            } catch {
              /* Best-effort storage. */
            }
          },
        })),
        merge: (persisted, current) => {
          const blob = (persisted as PersistedSurfacePrefsBlob | null) ?? {};
          return {
            ...current,
            widths: normalizeSlotWidths(blob.widths),
            panels: normalizePanelPrefs(blob.panels),
            railPrefs: normalizeRailPrefs(blob.railPrefs),
            documentPrefs: normalizeDocumentPrefs(blob.documentPrefs),
          };
        },
        partialize: (state) => ({
          widths: state.widths,
          panels: state.panels,
          railPrefs: state.railPrefs,
          documentPrefs: state.documentPrefs,
        }),
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
      setSlotWidth: state.setSlotWidth,
      setSlotOpen: state.setSlotOpen,
      setRailExpanded: state.setRailExpanded,
      setRailHeight: state.setRailHeight,
      setPropertiesOpen: state.setPropertiesOpen,
      setHydrated: state.setHydrated,
    })),
  );
}
