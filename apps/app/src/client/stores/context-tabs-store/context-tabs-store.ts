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
 * route, not a tab, so restore rides the tree-validated open; see the canonical `client/working-set` store.)
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
      provisionalName?: boolean;
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
  | { kind: "new"; documentId: string; name: string; draftOnly?: boolean };

export type ServerContextTab = Extract<ContextTab, { kind: "tracked" | "viewer" }>;

type ProjectTabsSlice = {
  tabs: ContextTab[];
  activeTabId: string | null;
};

type ContextTabsState = {
  /** projectId → slice. One tab list per project. */
  byProject: Record<string, ProjectTabsSlice>;
};

type ContextTabsActions = {
  openTab: (projectId: string, tab: ContextTab) => void;
  remintNewTab: (projectId: string, documentId: string, replacementId: string) => void;
  materializeNewTab: (projectId: string, documentId: string, tab: ServerContextTab) => void;
  updateTrackedTab: (
    projectId: string,
    documentId: string,
    metadata: Partial<Extract<ContextTab, { kind: "tracked" }>>,
  ) => void;
  /**
   * Close a tab. Returns the adjacent tab that should become active if the
   * caller closed the currently route-active tab, or `null` if no tabs remain.
   */
  closeTab: (projectId: string, documentId: string) => ContextTab | null;
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

function removeTabs(
  slice: ProjectTabsSlice,
  shouldRemove: (tab: ContextTab) => boolean,
): { slice: ProjectTabsSlice; fallback: ContextTab | null; changed: boolean } {
  const nextTabs = slice.tabs.filter((tab) => !shouldRemove(tab));
  if (nextTabs.length === slice.tabs.length) return { slice, fallback: null, changed: false };

  const activeIndex = slice.tabs.findIndex((tab) => tab.documentId === slice.activeTabId);
  const activeRemoved = activeIndex >= 0 && shouldRemove(slice.tabs[activeIndex]);
  const activeMissing = slice.activeTabId !== null && activeIndex < 0;
  const fallback = activeRemoved
    ? (slice.tabs.slice(activeIndex + 1).find((tab) => !shouldRemove(tab)) ??
      slice.tabs
        .slice(0, activeIndex)
        .reverse()
        .find((tab) => !shouldRemove(tab)) ??
      null)
    : activeMissing
      ? (nextTabs[0] ?? null)
      : null;
  return {
    changed: true,
    fallback,
    slice: {
      tabs: nextTabs,
      activeTabId:
        activeRemoved || activeMissing ? (fallback?.documentId ?? null) : slice.activeTabId,
    },
  };
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

      remintNewTab: (projectId, documentId, replacementId) => {
        set((state) => {
          const slice = sliceFor(state, projectId);
          if (
            !slice.tabs.some(
              (candidate) => candidate.kind === "new" && candidate.documentId === documentId,
            )
          )
            return state;
          return patchSlice(state, projectId, {
            tabs: slice.tabs.map((candidate) =>
              candidate.kind === "new" && candidate.documentId === documentId
                ? { ...candidate, documentId: replacementId }
                : candidate,
            ),
            activeTabId: slice.activeTabId === documentId ? replacementId : slice.activeTabId,
          });
        });
      },

      materializeNewTab: (projectId, documentId, tab) => {
        set((state) => {
          const slice = sliceFor(state, projectId);
          if (!slice.tabs.some((candidate) => candidate.documentId === documentId)) return state;
          return patchSlice(state, projectId, {
            ...slice,
            tabs: slice.tabs.map((candidate) =>
              candidate.documentId === documentId ? tab : candidate,
            ),
          });
        });
      },

      updateTrackedTab: (projectId, documentId, metadata) => {
        set((state) => {
          const slice = sliceFor(state, projectId);
          return patchSlice(state, projectId, {
            ...slice,
            tabs: slice.tabs.map((candidate) =>
              candidate.kind === "tracked" && candidate.documentId === documentId
                ? { ...candidate, ...metadata }
                : candidate,
            ),
          });
        });
      },

      closeTab: (projectId, documentId) => {
        const slice = sliceFor(get(), projectId);
        const removed = removeTabs(slice, (tab) => tab.documentId === documentId);
        if (!removed.changed) return null;
        set((state) => patchSlice(state, projectId, removed.slice));
        return removed.fallback;
      },

      resolveDraftOnlyTab: (projectId, documentId, outcome) => {
        set((state) => {
          const slice = sliceFor(state, projectId);
          const tab = slice.tabs.find((t) => t.documentId === documentId);
          if (tab?.kind !== "tracked" || !tab.draftOnly) return state;
          if (outcome === "discarded") {
            return patchSlice(
              state,
              projectId,
              removeTabs(slice, (candidate) => candidate.documentId === documentId).slice,
            );
          }
          const nextTabs = slice.tabs.map((candidate) =>
            candidate.documentId === documentId ? { ...candidate, draftOnly: false } : candidate,
          );
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
          const removed = removeTabs(slice, (tab) => {
            if (tab.kind === "new") return false;
            if (!isWorkScopedProjectContextScheme(tab.scheme)) return false;
            return tab.workId !== activeWorkId;
          });
          if (!removed.changed) return state;
          return patchSlice(state, projectId, removed.slice);
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
      remintNewTab: s.remintNewTab,
      materializeNewTab: s.materializeNewTab,
      updateTrackedTab: s.updateTrackedTab,
      closeTab: s.closeTab,
      reorderTabs: s.reorderTabs,
      selectTab: s.selectTab,
      resolveDraftOnlyTab: s.resolveDraftOnlyTab,
      pruneWorkScopedTabs: s.pruneWorkScopedTabs,
      clearProject: s.clearProject,
    })),
  );
}
