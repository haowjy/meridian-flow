/**
 * Context tabs store — each Project's ordered device-local Context desk.
 *
 * The browser route remains candidate/navigation state. This store owns open
 * tab metadata and one exact selected document ID per Work so local empty
 * documents can retain identity without becoming server working-set routes.
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
      /** Device provenance retained after a local Untitled materializes. */
      origin?: "local-untitled";
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
  | {
      kind: "new";
      documentId: string;
      name: string;
      /** Canonical Work owner captured when the local Scratch document is created. */
      workId: string;
      draftOnly?: boolean;
    };

export type ServerContextTab = Extract<ContextTab, { kind: "tracked" | "viewer" }>;

export type ProjectTabsSlice = {
  tabs: ContextTab[];
  selectedTabIdByWork: Record<string, string>;
};

type ContextTabsState = {
  /** projectId → slice. One tab list per project. */
  byProject: Record<string, ProjectTabsSlice>;
  _deskHydrated: boolean;
};

type ContextTabsActions = {
  openTab: (projectId: string, tab: ContextTab) => void;
  remintNewTab: (projectId: string, documentId: string, replacementId: string) => void;
  materializeNewTab: (
    projectId: string,
    documentId: string,
    tab: Extract<ContextTab, { kind: "tracked" }>,
  ) => void;
  updateTrackedTab: (
    projectId: string,
    documentId: string,
    metadata: Partial<Extract<ContextTab, { kind: "tracked" }>>,
  ) => void;
  reorderTabs: (projectId: string, fromIndex: number, toIndex: number) => void;
  selectTab: (projectId: string, workId: string, documentId: string | null) => void;
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
const EMPTY_SLICE: ProjectTabsSlice = { tabs: [], selectedTabIdByWork: {} };

function emptySlice(): ProjectTabsSlice {
  return EMPTY_SLICE;
}

function mergeTabMetadata(existing: ContextTab, incoming: ContextTab): ContextTab {
  const merged = { ...existing, ...incoming } as ContextTab;
  if (
    existing.kind === "tracked" &&
    existing.origin === "local-untitled" &&
    merged.kind === "tracked"
  ) {
    merged.origin = "local-untitled";
  }
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
      selectedTabIdByWork: rewriteSelectionValues(
        slice.selectedTabIdByWork,
        occupiedLocatorIndex >= 0 ? slice.tabs[occupiedLocatorIndex]?.documentId : undefined,
        incoming.documentId,
      ),
    };
  }

  if (occupiedLocatorIndex >= 0) {
    const replacedId = slice.tabs[occupiedLocatorIndex]?.documentId;
    return {
      tabs: slice.tabs.map((candidate, index) =>
        index === occupiedLocatorIndex ? incoming : candidate,
      ),
      selectedTabIdByWork: rewriteSelectionValues(
        slice.selectedTabIdByWork,
        replacedId,
        incoming.documentId,
      ),
    };
  }
  return { ...slice, tabs: [...slice.tabs, incoming] };
}

function canonicalizeTabs(tabs: readonly ContextTab[]): ContextTab[] {
  return tabs.reduce<ContextTab[]>(
    (canonical, tab) => upsertTab({ tabs: canonical, selectedTabIdByWork: {} }, tab).tabs,
    [],
  );
}

export function contextTabMayBeSelectedForWork(tab: ContextTab, workId: string): boolean {
  return tab.kind === "new" || tab.scheme === "scratch" || tab.scheme === "uploads"
    ? tab.workId === workId
    : true;
}

function rewriteSelectionValues(
  selections: Record<string, string>,
  from: string | undefined,
  to: string,
): Record<string, string> {
  if (!from || from === to) return selections;
  return Object.fromEntries(
    Object.entries(selections).map(([workId, documentId]) => [
      workId,
      documentId === from ? to : documentId,
    ]),
  );
}

function normalizeSelections(
  tabs: readonly ContextTab[],
  selections: Record<string, string>,
): Record<string, string> {
  const byId = new Map(tabs.map((tab) => [tab.documentId, tab]));
  return Object.fromEntries(
    Object.entries(selections).filter(([workId, documentId]) => {
      const tab = byId.get(documentId);
      return tab !== undefined && contextTabMayBeSelectedForWork(tab, workId);
    }),
  );
}

function normalizeSlice(slice: ProjectTabsSlice): ProjectTabsSlice {
  return {
    ...slice,
    selectedTabIdByWork: normalizeSelections(slice.tabs, slice.selectedTabIdByWork),
  };
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
          return patchSlice(state, projectId, normalizeSlice(upsertTab(slice, tab)));
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
            selectedTabIdByWork: rewriteSelectionValues(
              slice.selectedTabIdByWork,
              documentId,
              replacementId,
            ),
          });
        });
      },

      materializeNewTab: (projectId, documentId, tab) => {
        set((state) => {
          const slice = sliceFor(state, projectId);
          if (!slice.tabs.some((candidate) => candidate.documentId === documentId)) return state;
          const withoutNew: ProjectTabsSlice = {
            tabs: slice.tabs.filter((candidate) => candidate.documentId !== documentId),
            selectedTabIdByWork: rewriteSelectionValues(
              slice.selectedTabIdByWork,
              documentId,
              tab.documentId,
            ),
          };
          return patchSlice(
            state,
            projectId,
            normalizeSlice(upsertTab(withoutNew, { ...tab, origin: "local-untitled" })),
          );
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
            ? patchSlice(
                state,
                projectId,
                normalizeSlice(upsertTab(slice, { ...tab, ...metadata })),
              )
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

      selectTab: (projectId, workId, documentId) => {
        set((state) => {
          const slice = sliceFor(state, projectId);
          const next = { ...slice.selectedTabIdByWork };
          if (documentId === null) delete next[workId];
          else {
            const tab = slice.tabs.find((candidate) => candidate.documentId === documentId);
            if (!tab || !contextTabMayBeSelectedForWork(tab, workId)) return state;
            next[workId] = documentId;
          }
          if (slice.selectedTabIdByWork[workId] === next[workId]) return state;
          return patchSlice(state, projectId, { ...slice, selectedTabIdByWork: next });
        });
      },

      replaceTabs: (projectId, tabs) => {
        set((state) => {
          const current = sliceFor(state, projectId);
          const canonicalTabs = canonicalizeTabs(tabs);
          const selectedTabIdByWork = normalizeSelections(
            canonicalTabs,
            current.selectedTabIdByWork,
          );
          if (
            JSON.stringify(current.selectedTabIdByWork) === JSON.stringify(selectedTabIdByWork) &&
            current.tabs.length === canonicalTabs.length &&
            current.tabs.every((tab, index) =>
              contextTabEquals(tab, canonicalTabs[index] as ContextTab),
            )
          ) {
            return state;
          }
          return patchSlice(state, projectId, { tabs: canonicalTabs, selectedTabIdByWork });
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
          return patchSlice(state, projectId, {
            tabs: nextTabs,
            selectedTabIdByWork: normalizeSelections(nextTabs, current.selectedTabIdByWork),
          });
        });
      },
    }),
    { name: "context-tabs-store", enabled: import.meta.env.DEV },
  ),
);

/** Coordinator-only atomic desk commit. Live feature callers use named coordinator commands. */
export function commitPlannedContextRemoval(
  projectId: string,
  input: {
    documentIds: readonly string[];
    deskSelection?: { workId: string; documentId: string | null };
  },
): ContextTab[] {
  const documentIds = new Set(input.documentIds);
  const slice = sliceFor(useContextTabsStore.getState(), projectId);
  const removed = slice.tabs.filter((tab) => documentIds.has(tab.documentId));
  useContextTabsStore.setState((state) => {
    const current = sliceFor(state, projectId);
    const tabs = current.tabs.filter((tab) => !documentIds.has(tab.documentId));
    const selections = { ...current.selectedTabIdByWork };
    if (input.deskSelection) {
      const { workId, documentId } = input.deskSelection;
      if (documentId === null) delete selections[workId];
      else selections[workId] = documentId;
    }
    return patchSlice(state, projectId, {
      tabs,
      selectedTabIdByWork: normalizeSelections(tabs, selections),
    });
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

useContextTabsStore.subscribe((state, previous) => {
  if (!state._deskHydrated || state.byProject === previous.byProject) return;
  deviceDesk?.replace(state.byProject);
});

/** Loads every project desk before the authenticated workspace is revealed. */
export function rehydrateContextDesks(userId: string): void {
  if (typeof window === "undefined") return;
  deviceDesk ??= new DeviceContextDeskStore(localStorage);
  const byProject = deviceDesk.setUser(userId);
  useContextTabsStore.setState({ byProject, _deskHydrated: true });
  // Rewrites stale exclusions immediately, including completed untitleds.
  deviceDesk.replace(byProject);
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
