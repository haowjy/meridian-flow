/**
 * Device-local project chrome preferences.
 *
 * Widths belong to slots (the left rail and the dock), so whatever surface sits in
 * a slot reads one width. Open/closed belongs to the mode: Write and Chat each
 * remember their own rail and dock, and restore them as a unit on a mode switch.
 * Placement is not stored here: it is a pure function of the mode.
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { createJSONStorage, devtools, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import { MODE_KEYS, type ModeKey, type PanelSlotId } from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type SlotWidths = Record<PanelSlotId, number>;
export type ModePanels = { railOpen: boolean; dockOpen: boolean };
export type ModePanelsMap = Record<ModeKey, ModePanels>;

export const SLOT_WIDTH_BOUNDS: Record<PanelSlotId, { min: number; max: number }> = {
  "rail-l": { min: 220, max: 380 },
  // Below this the dock header's chat picker and rename input compress into slivers.
  dock: { min: 280, max: 520 },
};

export const DEFAULT_SLOT_WIDTHS: SlotWidths = { "rail-l": 264, dock: 360 };

/** Write gives the page the room; Chat shows the page beside the conversation. */
export const DEFAULT_MODE_PANELS: ModePanelsMap = {
  write: { railOpen: true, dockOpen: false },
  chat: { railOpen: true, dockOpen: true },
};

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

export function normalizeModePanels(modes?: Partial<Record<ModeKey, Partial<ModePanels>>> | null) {
  const normalized = {} as ModePanelsMap;
  for (const mode of MODE_KEYS) {
    const saved = modes?.[mode];
    const defaults = DEFAULT_MODE_PANELS[mode];
    normalized[mode] = {
      railOpen: typeof saved?.railOpen === "boolean" ? saved.railOpen : defaults.railOpen,
      dockOpen: typeof saved?.dockOpen === "boolean" ? saved.dockOpen : defaults.dockOpen,
    };
  }
  return normalized;
}

type PersistedSurfacePrefsBlob = {
  widths?: Partial<SlotWidths> | null;
  modes?: Partial<Record<ModeKey, Partial<ModePanels>>> | null;
  railPrefs?: Partial<RailPrefs> | null;
  documentPrefs?: Partial<DocumentPrefs> | null;
};

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

export type RailSectionId = "scratch" | "user" | "recent";
/** The rail sections docked above the account row, each trading height with the tree. */
export type DockedRailSectionId = "scratch" | "user";
export type RailPrefs = {
  scratchExpanded: boolean;
  userExpanded: boolean;
  recentExpanded: boolean;
  scratchHeight: number | null;
  userHeight: number | null;
};
export const DEFAULT_RAIL_PREFS: RailPrefs = {
  scratchExpanded: false,
  userExpanded: false,
  recentExpanded: true,
  scratchHeight: null,
  userHeight: null,
};

function savedHeight(height: unknown): number | null {
  return typeof height === "number" && Number.isFinite(height) && height > 0
    ? Math.round(height)
    : null;
}

export function normalizeRailPrefs(prefs?: Partial<RailPrefs> | null): RailPrefs {
  return {
    scratchExpanded: typeof prefs?.scratchExpanded === "boolean" ? prefs.scratchExpanded : false,
    userExpanded: typeof prefs?.userExpanded === "boolean" ? prefs.userExpanded : false,
    recentExpanded: typeof prefs?.recentExpanded === "boolean" ? prefs.recentExpanded : true,
    scratchHeight: savedHeight(prefs?.scratchHeight),
    userHeight: savedHeight(prefs?.userHeight),
  };
}

export type SurfacePrefsState = {
  widths: SlotWidths;
  modes: ModePanelsMap;
  railPrefs: RailPrefs;
  documentPrefs: DocumentPrefs;
};

export type SurfacePrefsActions = {
  setSlotWidth: (slot: PanelSlotId, widthPx: number) => void;
  setSlotOpen: (mode: ModeKey, slot: PanelSlotId, open: boolean) => void;
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

function openKey(slot: PanelSlotId): keyof ModePanels {
  return slot === "rail-l" ? "railOpen" : "dockOpen";
}

export const useProjectSurfacePrefsStore: SurfacePrefsStore = create<SurfacePrefsSlice>()(
  devtools(
    persist(
      (set) => ({
        widths: DEFAULT_SLOT_WIDTHS,
        modes: DEFAULT_MODE_PANELS,
        railPrefs: DEFAULT_RAIL_PREFS,
        documentPrefs: DEFAULT_DOCUMENT_PREFS,
        _hydrated: false,

        setSlotWidth: (slot, width) =>
          set((state) => ({ widths: { ...state.widths, [slot]: savedWidth(slot, width) } })),
        setSlotOpen: (mode, slot, open) =>
          set((state) => ({
            modes: { ...state.modes, [mode]: { ...state.modes[mode], [openKey(slot)]: open } },
          })),
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
        version: 5,
        // Version 4 kept open/closed per surface; nothing of it carries over.
        migrate: () => ({}),
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
            modes: normalizeModePanels(blob.modes),
            railPrefs: normalizeRailPrefs(blob.railPrefs),
            documentPrefs: normalizeDocumentPrefs(blob.documentPrefs),
          };
        },
        partialize: (state) => ({
          widths: state.widths,
          modes: state.modes,
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
