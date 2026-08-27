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
 *  - `reorderTabs` moves a tab to a new index.
 *
 * The ordered per-project desk is persisted device-locally. Project entry
 * validates restored routes against current trees before they remain usable.
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
import { DeviceContextDeskStore } from "./context-desk-storage";
import { sameServerContextTabLocator } from "./context-tab-locator";
export type ContextTab =
  | {
      kind: "tracked";
      documentId: string;
      scheme: ProjectContextTreeScheme;
      path: string;
      name: string;
      workId?: string;
      draftOnly?: boolean;
      /** Transient owner of a draft-synthesized review tab; never persisted. */
      reviewWorkId?: string;
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
      /** Transient owner of a draft-synthesized review tab; never persisted. */
      reviewWorkId?: string;
      editable: false;
      fileType: DocumentFileType;
      mimeType?: string;
    }
  | { kind: "new"; documentId: string; name: string; draftOnly?: boolean };

export type ServerContextTab = Extract<ContextTab, { kind: "tracked" | "viewer" }>;

export type ProjectTabsSlice = {
  tabs: ContextTab[];
  activeTabId: string | null;
};

type ContextTabsState = {
  /** projectId → slice. One tab list per project. */
  byProject: Record<string, ProjectTabsSlice>;
  _deskHydrated: boolean;
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
  reorderTabs: (projectId: string, fromIndex: number, toIndex: number) => void;
  selectTab: (projectId: string, documentId: string | null) => void;
  /** Replace a project's desk without selecting a tab. */
  replaceTabs: (projectId: string, tabs: ContextTab[]) => void;
  /** Reconcile an async validation snapshot without clobbering tabs opened meanwhile. */
  reconcileTabs: (
    projectId: string,
    restoredDocumentIds: ReadonlySet<string>,
    tabs: ContextTab[],
  ) => void;
};

// Stable shared reference for the empty slice. Returning a fresh object literal
// here defeats `useShallow` in `useContextTabs`: a new `tabs: []` identity every
// call makes the snapshot unequal on every render -> "getSnapshot should be
// cached" -> infinite render loop. Never mutated (all updates are immutable).
const EMPTY_SLICE: ProjectTabsSlice = { tabs: [], activeTabId: null };

function emptySlice(): ProjectTabsSlice {
  return EMPTY_SLICE;
}

function mergeTabMetadata(existing: ContextTab, incoming: ContextTab): ContextTab {
  const merged = { ...existing, ...incoming } as ContextTab;
  if (incoming.kind !== "tracked" || incoming.draftOnly) return merged;
  // A tracked tab from the live context tree proves that a draft-created
  // document was committed; omitted optional fields must not retain the marker.
  const {
    draftOnly: _draftOnly,
    reviewWorkId: _reviewWorkId,
    ...liveTab
  } = merged as ServerContextTab;
  return liveTab as ContextTab;
}

function upsertTab(slice: ProjectTabsSlice, incoming: ContextTab): ProjectTabsSlice {
  const sameDocumentIndex = slice.tabs.findIndex(
    (candidate) => candidate.documentId === incoming.documentId,
  );
  const occupiedLocatorIndex =
    incoming.kind === "new"
      ? -1
      : slice.tabs.findIndex(
          (candidate) =>
            candidate.kind !== "new" &&
            candidate.documentId !== incoming.documentId &&
            sameServerContextTabLocator(candidate, incoming),
        );

  if (sameDocumentIndex >= 0) {
    const tabs = slice.tabs
      .filter((_candidate, index) => index !== occupiedLocatorIndex)
      .map((candidate) =>
        candidate.documentId === incoming.documentId
          ? mergeTabMetadata(candidate, incoming)
          : candidate,
      );
    return {
      tabs,
      activeTabId:
        occupiedLocatorIndex >= 0 &&
        slice.tabs[occupiedLocatorIndex]?.documentId === slice.activeTabId
          ? incoming.documentId
          : slice.activeTabId,
    };
  }

  if (occupiedLocatorIndex >= 0) {
    const replacedId = slice.tabs[occupiedLocatorIndex]?.documentId;
    return {
      tabs: slice.tabs.map((candidate, index) =>
        index === occupiedLocatorIndex ? incoming : candidate,
      ),
      activeTabId: slice.activeTabId === replacedId ? incoming.documentId : slice.activeTabId,
    };
  }
  return { ...slice, tabs: [...slice.tabs, incoming] };
}

function canonicalizeTabs(tabs: readonly ContextTab[]): ContextTab[] {
  return tabs.reduce<ContextTab[]>(
    (canonical, tab) => upsertTab({ tabs: canonical, activeTabId: null }, tab).tabs,
    [],
  );
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

function contextTabEquals(left: ContextTab, right: ContextTab): boolean {
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every((key) => leftRecord[key] === rightRecord[key])
  );
}

function resolveCommittedDraftMetadata(
  slice: ProjectTabsSlice,
  reviewWorkId: string,
  documentId: string,
): ProjectTabsSlice | null {
  const tab = slice.tabs.find((candidate) => candidate.documentId === documentId);
  if (tab?.kind !== "tracked" || !tab.draftOnly || tab.reviewWorkId !== reviewWorkId) return null;
  return {
    ...slice,
    tabs: slice.tabs.map((candidate) => {
      if (candidate.documentId !== documentId || candidate.kind !== "tracked") return candidate;
      const { draftOnly: _draftOnly, reviewWorkId: _reviewWorkId, ...committed } = candidate;
      return committed;
    }),
  };
}

export const useContextTabsStore = create<ContextTabsState & ContextTabsActions>()(
  devtools(
    (set) => ({
      byProject: {},
      _deskHydrated: false,

      openTab: (projectId, tab) => {
        set((state) => {
          const slice = sliceFor(state, projectId);
          return patchSlice(state, projectId, upsertTab(slice, tab));
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
          const withoutNew = {
            tabs: slice.tabs.filter((candidate) => candidate.documentId !== documentId),
            activeTabId: slice.activeTabId === documentId ? tab.documentId : slice.activeTabId,
          };
          return patchSlice(state, projectId, upsertTab(withoutNew, tab));
        });
      },

      updateTrackedTab: (projectId, documentId, metadata) => {
        set((state) => {
          const slice = sliceFor(state, projectId);
          const tab = slice.tabs.find(
            (candidate): candidate is Extract<ContextTab, { kind: "tracked" }> =>
              candidate.kind === "tracked" && candidate.documentId === documentId,
          );
          return tab
            ? patchSlice(state, projectId, upsertTab(slice, { ...tab, ...metadata }))
            : state;
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

      replaceTabs: (projectId, tabs) => {
        set((state) => {
          const current = sliceFor(state, projectId);
          const canonicalTabs = canonicalizeTabs(tabs);
          const activeTabId = canonicalTabs.some((tab) => tab.documentId === current.activeTabId)
            ? current.activeTabId
            : null;
          if (
            current.activeTabId === activeTabId &&
            current.tabs.length === canonicalTabs.length &&
            current.tabs.every((tab, index) =>
              contextTabEquals(tab, canonicalTabs[index] as ContextTab),
            )
          ) {
            return state;
          }
          return patchSlice(state, projectId, { tabs: canonicalTabs, activeTabId });
        });
      },

      reconcileTabs: (projectId, restoredDocumentIds, tabs) => {
        set((state) => {
          const current = sliceFor(state, projectId);
          const validated = new Map(canonicalizeTabs(tabs).map((tab) => [tab.documentId, tab]));
          const nextTabs = canonicalizeTabs(
            current.tabs.flatMap((tab) => {
              if (!restoredDocumentIds.has(tab.documentId)) return [tab];
              const replacement = validated.get(tab.documentId);
              return replacement ? [replacement] : [];
            }),
          );
          const activeTabId = nextTabs.some((tab) => tab.documentId === current.activeTabId)
            ? current.activeTabId
            : null;
          return patchSlice(state, projectId, { tabs: nextTabs, activeTabId });
        });
      },
    }),
    { name: "context-tabs-store", enabled: import.meta.env.DEV },
  ),
);

/** Coordinator-only atomic desk commit. Live feature callers use named coordinator commands. */
export function commitPlannedContextRemoval(
  projectId: string,
  input: { documentIds: readonly string[]; activeTabId: string | null },
): ContextTab[] {
  const documentIds = new Set(input.documentIds);
  const slice = sliceFor(useContextTabsStore.getState(), projectId);
  const removed = slice.tabs.filter((tab) => documentIds.has(tab.documentId));
  if (removed.length === 0 && slice.activeTabId === input.activeTabId) return [];
  useContextTabsStore.setState((state) => {
    const current = sliceFor(state, projectId);
    const tabs = current.tabs.filter((tab) => !documentIds.has(tab.documentId));
    const activeTabId = tabs.some((tab) => tab.documentId === input.activeTabId)
      ? input.activeTabId
      : null;
    return patchSlice(state, projectId, { tabs, activeTabId });
  });
  return removed;
}

/** Coordinator-only draft metadata commit; discard is a distinct removal command. */
export function commitDraftApplyMetadata(
  projectId: string,
  reviewWorkId: string,
  documentId: string,
): void {
  useContextTabsStore.setState((state) => {
    const resolved = resolveCommittedDraftMetadata(
      sliceFor(state, projectId),
      reviewWorkId,
      documentId,
    );
    return resolved ? patchSlice(state, projectId, resolved) : state;
  });
}

/** Selector helper — returns the tab slice for a project (stable empty default). */
export function useContextTabs(projectId: string): ProjectTabsSlice {
  return useContextTabsStore(useShallow((s) => s.byProject[projectId] ?? EMPTY_SLICE));
}

let deviceDesk: DeviceContextDeskStore | null = null;
let pendingUntitled: ((documentId: string) => boolean) | null = null;

useContextTabsStore.subscribe((state, previous) => {
  if (!state._deskHydrated || state.byProject === previous.byProject) return;
  deviceDesk?.replace(state.byProject, pendingUntitled ?? (() => false));
});

/** Loads every project desk before the authenticated workspace is revealed. */
export function rehydrateContextDesks(
  userId: string,
  isUntitledPending: (documentId: string) => boolean,
): void {
  if (typeof window === "undefined") return;
  deviceDesk ??= new DeviceContextDeskStore(localStorage);
  pendingUntitled = isUntitledPending;
  const byProject = deviceDesk.setUser(userId, isUntitledPending);
  useContextTabsStore.setState({ byProject, _deskHydrated: true });
  // Rewrites stale exclusions immediately, including completed untitleds.
  deviceDesk.replace(byProject, isUntitledPending);
}

/** Persists a non-tab lifecycle transition, such as an untitled becoming pending. */
export function flushContextDesks(): void {
  if (!deviceDesk || !pendingUntitled) return;
  deviceDesk.replace(useContextTabsStore.getState().byProject, pendingUntitled);
}

export function useContextTabsActions(): ContextTabsActions {
  return useContextTabsStore(
    useShallow((s) => ({
      openTab: s.openTab,
      remintNewTab: s.remintNewTab,
      materializeNewTab: s.materializeNewTab,
      updateTrackedTab: s.updateTrackedTab,
      reorderTabs: s.reorderTabs,
      selectTab: s.selectTab,
      replaceTabs: s.replaceTabs,
      reconcileTabs: s.reconcileTabs,
    })),
  );
}
