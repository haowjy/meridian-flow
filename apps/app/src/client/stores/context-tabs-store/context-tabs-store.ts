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
 * navigation, not a chrome preference. Restoring tabs across
 * reloads would resurrect stale read-route 404s for files that may have since
 * been deleted. (The last-opened FILE is remembered across reloads — as a
 * route, not a tab, so restore rides the tree-validated open; see
 * `features/project/context/context-last-route.ts`.)
 */

import type {
  DocumentFileType,
  Filetype,
  ProjectContextTreeScheme,
  YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import type { TempDocument } from "../temp-docs-store";

export type ContextTab =
  | {
      kind: "tracked";
      documentId: string;
      scheme: ProjectContextTreeScheme;
      path: string;
      name: string;
      workId?: string;
      draftOnly?: boolean;
      editable: true;
      filetype: Filetype;
      schemaType: YjsTrackedSchemaType;
    }
  | {
      kind: "viewer";
      documentId: string;
      scheme: ProjectContextTreeScheme;
      path: string;
      name: string;
      workId?: string;
      draftOnly?: boolean;
      editable: false;
      fileType: DocumentFileType;
      mimeType?: string;
    }
  | { kind: "temp"; documentId: string; name: string; document: TempDocument };

export type ServerContextTab = Extract<ContextTab, { kind: "tracked" | "viewer" }>;

type ProjectTabsSlice = {
  tabs: ServerContextTab[];
  activeTabId: string | null;
};

type ContextTabsState = {
  /** projectId → slice. One tab list per project. */
  byProject: Record<string, ProjectTabsSlice>;
};

type ContextTabsActions = {
  openTab: (projectId: string, tab: ServerContextTab) => void;
  /**
   * Close a tab. Returns the adjacent tab that should become active if the
   * caller closed the currently route-active tab, or `null` if no tabs remain.
   */
  closeTab: (projectId: string, documentId: string) => ServerContextTab | null;
  reorderTabs: (projectId: string, fromIndex: number, toIndex: number) => void;
  selectTab: (projectId: string, documentId: string | null) => void;
  /**
   * Resolve a draft-only tab when its backing draft reaches a terminal state:
   * `committed` (accepted — the document now exists in the tree, so keep the
   * tab and drop the marker) or `discarded` (the document never existed
   * outside the draft — close the tab so it can't linger as an editable
   * ghost over a document that no longer loads). No-op for tabs without the
   * marker: discarding a draft on an existing document must not close it.
   */
  resolveDraftOnlyTab: (
    projectId: string,
    documentId: string,
    outcome: "committed" | "discarded",
  ) => void;
  /** Drop work-scoped tabs that belong to a different active work. */
  pruneWorkScopedTabs: (projectId: string, activeWorkId: string | null) => void;
  /** Clear every tab for a project — used when the project is deleted. */
  clearProject: (projectId: string) => void;
};

// Stable shared reference for the empty slice. Returning a fresh object literal
// here defeats `useShallow` in `useContextTabs`: a new `tabs: []` identity every
// call makes the snapshot unequal on every render -> "getSnapshot should be
// cached" -> infinite render loop. Never mutated (all updates are immutable).
const EMPTY_SLICE: ProjectTabsSlice = { tabs: [], activeTabId: null };

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
          return patchSlice(state, projectId, { ...slice, tabs: nextTabs });
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
        set((state) =>
          patchSlice(state, projectId, {
            tabs: nextTabs,
            activeTabId:
              slice.activeTabId === documentId ? (fallback?.documentId ?? null) : slice.activeTabId,
          }),
        );
        return fallback;
      },

      resolveDraftOnlyTab: (projectId, documentId, outcome) => {
        set((state) => {
          const slice = sliceFor(state, projectId);
          const tab = slice.tabs.find((t) => t.documentId === documentId);
          if (!tab?.draftOnly) return state;
          const nextTabs =
            outcome === "committed"
              ? slice.tabs.map((t) =>
                  t.documentId === documentId ? { ...t, draftOnly: false } : t,
                )
              : slice.tabs.filter((t) => t.documentId !== documentId);
          return patchSlice(state, projectId, { ...slice, tabs: nextTabs });
        });
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
          return patchSlice(state, projectId, { ...slice, tabs: next });
        });
      },

      selectTab: (projectId, documentId) => {
        set((state) => {
          const slice = sliceFor(state, projectId);
          return patchSlice(state, projectId, { ...slice, activeTabId: documentId });
        });
      },

      pruneWorkScopedTabs: (projectId, activeWorkId) => {
        set((state) => {
          const slice = sliceFor(state, projectId);
          const nextTabs = slice.tabs.filter((tab) => {
            if (!isWorkScopedProjectContextScheme(tab.scheme)) return true;
            return tab.workId === activeWorkId;
          });
          if (nextTabs.length === slice.tabs.length) return state;
          return patchSlice(state, projectId, { ...slice, tabs: nextTabs });
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
      selectTab: s.selectTab,
      resolveDraftOnlyTab: s.resolveDraftOnlyTab,
      pruneWorkScopedTabs: s.pruneWorkScopedTabs,
      clearProject: s.clearProject,
    })),
  );
}
