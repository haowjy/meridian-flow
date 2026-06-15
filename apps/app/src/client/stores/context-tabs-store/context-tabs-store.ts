/**
 * Context tabs store — per-project open-file working set for the Context
 * destination.
 *
 * The browser route (`?scheme=` / `?path=`) owns which context file is active.
 * This store deliberately keeps only the open tabs and their server-derived
 * display metadata so the tab strip can render a working set without creating a
 * second selection source of truth.
 *
 * Lifecycle:
 *  - `openTab` adds the tab if missing (idempotent — clicking a tree row that
 *    is already open just refreshes its metadata).
 *  - `closeTab` removes the tab and returns the right-hand neighbour (or the
 *    left-hand neighbour when the right side is empty) so the route owner can
 *    choose where `?path=` should move when the closed tab was active.
 *  - `reorderTabs` moves a tab to a new index (pin is deferred — this is the
 *    primitive a future pin/unpin will compose with).
 *
 * Persisted in-memory only: tabs are an ephemeral working set that follows
 * navigation, not a chrome preference like `layout-store`. Restoring tabs across
 * reloads would resurrect stale read-route 404s for files that may have since
 * been deleted.
 */

import type {
  DocumentFileType,
  Filetype,
  ProjectContextTreeScheme,
  YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

export type ContextTab = {
  documentId: string;
  scheme: ProjectContextTreeScheme;
  path: string;
  name: string;
} & (
  | {
      editable: true;
      filetype: Filetype;
      schemaType: YjsTrackedSchemaType;
    }
  | {
      editable: false;
      fileType: DocumentFileType;
      mimeType?: string;
    }
);

type ProjectTabsSlice = {
  tabs: ContextTab[];
};

type ContextTabsState = {
  /** projectId → slice. One tab list per project. */
  byProject: Record<string, ProjectTabsSlice>;
};

type ContextTabsActions = {
  openTab: (projectId: string, tab: ContextTab) => void;
  /**
   * Close a tab. Returns the adjacent tab that should become active if the
   * caller closed the currently route-active tab, or `null` if no tabs remain.
   */
  closeTab: (projectId: string, documentId: string) => ContextTab | null;
  reorderTabs: (projectId: string, fromIndex: number, toIndex: number) => void;
  /** Clear every tab for a project — used when the project is deleted. */
  clearProject: (projectId: string) => void;
};

// Stable shared reference for the empty slice. Returning a fresh object literal
// here defeats `useShallow` in `useContextTabs`: a new `tabs: []` identity every
// call makes the snapshot unequal on every render -> "getSnapshot should be
// cached" -> infinite render loop. Never mutated (all updates are immutable).
const EMPTY_SLICE: ProjectTabsSlice = { tabs: [] };

function emptySlice(): ProjectTabsSlice {
  return EMPTY_SLICE;
}

function sliceFor(state: ContextTabsState, projectId: string): ProjectTabsSlice {
  return state.byProject[projectId] ?? emptySlice();
}

function patchSlice(
  state: ContextTabsState,
  projectId: string,
  next: ProjectTabsSlice,
): ContextTabsState {
  return { ...state, byProject: { ...state.byProject, [projectId]: next } };
}

export const useContextTabsStore = create<ContextTabsState & ContextTabsActions>()(
  devtools(
    (set, get) => ({
      byProject: {},

      openTab: (projectId, tab) => {
        set((state) => {
          const slice = sliceFor(state, projectId);
          const exists = slice.tabs.some((t) => t.documentId === tab.documentId);
          const nextTabs = exists
            ? slice.tabs.map((t) =>
                // Refresh metadata for an already-open tab — file may have been
                // renamed (or appear in a new scheme) since it was first opened.
                t.documentId === tab.documentId ? { ...t, ...tab } : t,
              )
            : [...slice.tabs, tab];
          return patchSlice(state, projectId, { tabs: nextTabs });
        });
      },

      closeTab: (projectId, documentId) => {
        const slice = sliceFor(get(), projectId);
        const idx = slice.tabs.findIndex((t) => t.documentId === documentId);
        if (idx === -1) return null;
        const nextTabs = [...slice.tabs.slice(0, idx), ...slice.tabs.slice(idx + 1)];
        // Prefer the tab that took this one's slot (right neighbour after splice);
        // fall back to the new last tab if we closed the rightmost.
        const fallback = nextTabs[idx] ?? nextTabs[nextTabs.length - 1] ?? null;
        set((state) => patchSlice(state, projectId, { tabs: nextTabs }));
        return fallback;
      },

      reorderTabs: (projectId, fromIndex, toIndex) => {
        set((state) => {
          const slice = sliceFor(state, projectId);
          if (
            fromIndex === toIndex ||
            fromIndex < 0 ||
            toIndex < 0 ||
            fromIndex >= slice.tabs.length ||
            toIndex >= slice.tabs.length
          ) {
            return state;
          }
          const next = [...slice.tabs];
          const [moved] = next.splice(fromIndex, 1);
          next.splice(toIndex, 0, moved);
          return patchSlice(state, projectId, { tabs: next });
        });
      },

      clearProject: (projectId) => {
        set((state) => {
          if (!state.byProject[projectId]) return state;
          const { [projectId]: _removed, ...rest } = state.byProject;
          return { ...state, byProject: rest };
        });
      },
    }),
    { name: "context-tabs-store", enabled: import.meta.env.DEV },
  ),
);

/** Selector helper — returns the tab slice for a project (stable empty default). */
export function useContextTabs(projectId: string): ProjectTabsSlice {
  return useContextTabsStore(useShallow((s) => s.byProject[projectId] ?? EMPTY_SLICE));
}

export function useContextTabsActions(): ContextTabsActions {
  return useContextTabsStore(
    useShallow((s) => ({
      openTab: s.openTab,
      closeTab: s.closeTab,
      reorderTabs: s.reorderTabs,
      clearProject: s.clearProject,
    })),
  );
}
