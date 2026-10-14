/** Browser-context-local Editor membership. Zustand owns live state; sessionStorage restores it. */
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import { browserRecord } from "@/client/storage/browser-record";
import {
  type ContextTab,
  isDraftOnly,
  isEditorContextTab,
  isEditorTab,
  matchesTabInstance,
  type ProjectTabsSlice,
  reviewEntryOf,
  type TabOwner,
} from "./editor-workspace-model";
import {
  EDITOR_WORKSPACE_STORAGE_KEY,
  type EditorWorkspaceCommand,
  parseEditorWorkspace,
  reduceEditorWorkspace,
} from "./editor-workspace-state";

/** A tracked tab's changed metadata; an owner in it replaces the old one whole. */
export type TrackedTabPatch = Partial<
  Omit<Extract<ContextTab, { kind: "tracked" }>, keyof TabOwner | "tabInstanceId" | "reviews">
> &
  TabOwner;

export {
  type ContextTab,
  editorTabsForWork,
  isDraftOnly,
  isEditorContextTab,
  isEditorScheme,
  isEditorTab,
  matchesReviewItem,
  matchesTabInstance,
  type ProjectTabsSlice,
  type ReviewItemTabIdentity,
  replaceOwner,
  reviewEntriesOf,
  reviewEntryOf,
  type ServerContextTab,
  type TabOwner,
  tabContextOwner,
  withoutReviewEntry,
} from "./editor-workspace-model";

type ContextTabsState = {
  /** One tab per document, independent of other browser contexts. Draft-only tabs are never persisted. */
  byProject: Record<string, ProjectTabsSlice>;
  _workspaceHydrated: boolean;
  _layoutPersistenceError: unknown | null;
};

export type OpenEditorTabResult =
  | { kind: "opened"; tab: ContextTab }
  | { kind: "superseded" | "ineligible" | "not-opened" };

type ContextTabsActions = {
  openTab: (
    projectId: string,
    tab: ContextTab,
    isCurrent?: () => boolean,
    editorWorkId?: string,
  ) => OpenEditorTabResult;
  reconcileResourceTab: (
    projectId: string,
    resourceHandle: string,
    tab: ContextTab,
  ) => Promise<void>;
  updateTrackedTab: (
    projectId: string,
    addressed: ContextTab,
    metadata: TrackedTabPatch,
  ) => Promise<void>;
  reorderTabs: (projectId: string, fromIndex: number, toIndex: number) => Promise<void>;
  selectTab: (
    projectId: string,
    workId: string,
    documentId: string | null,
    addressed?: ContextTab,
  ) => Promise<void>;
  reconcileBootstrap: (
    projectId: string,
    changes: readonly { prior: ContextTab; next: ContextTab | null }[],
  ) => Promise<void>;
  applyAvailability: (
    projectId: string,
    prior: ProjectTabsSlice,
    next: ProjectTabsSlice,
  ) => Promise<void>;
  settleDraft: (projectId: string, tab: ContextTab) => Promise<DraftWorkspaceSettlementReceipt>;
  dropReviewEntry: (projectId: string, workId: string, tabInstanceId: string) => void;
};

export type DraftWorkspaceSettlementReceipt = { kind: "settled" } | { kind: "not-settled" };

// Stable shared reference for the empty slice. Returning a fresh object literal
// here defeats `useShallow` in `useContextTabs`: a new `tabs: []` identity every
// call makes the snapshot unequal on every render -> "getSnapshot should be
// cached" -> infinite render loop. Never mutated (all updates are immutable).
const EMPTY_SLICE: ProjectTabsSlice = { tabs: [], selectedTabIdByWork: {} };

function emptySlice(): ProjectTabsSlice {
  return EMPTY_SLICE;
}

function normalizeSelections(
  tabs: readonly ContextTab[],
  selections: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(selections).filter(([workId, documentId]) =>
      tabs.some((tab) => tab.documentId === documentId && isEditorTab(tab, workId)),
    ),
  );
}

function durableSlice(slice: ProjectTabsSlice): ProjectTabsSlice {
  const tabs = slice.tabs.filter((tab) => !isDraftOnly(tab) && isEditorContextTab(tab));
  return { tabs, selectedTabIdByWork: normalizeSelections(tabs, slice.selectedTabIdByWork) };
}

function sliceFor(state: ContextTabsState, projectId: string): ProjectTabsSlice {
  return state.byProject[projectId] ?? emptySlice();
}

type WorkspaceCommandBuilder = (
  state: ContextTabsState & ContextTabsActions,
) => EditorWorkspaceCommand | null;

export const useContextTabsStore = create<ContextTabsState & ContextTabsActions>()(
  devtools(
    (rawSet, get) => {
      const dispatchResult = (build: WorkspaceCommandBuilder, isCurrent?: () => boolean) => {
        if (isCurrent?.() === false) return null;
        const current = get();
        const command = build(current);
        if (!command) return null;
        const result = reduceEditorWorkspace(
          {
            version: 1,
            accountId: workspaceAccountId ?? "unhydrated",
            projects: current.byProject,
          },
          command,
        );
        if (result.kind === "committed") {
          rawSet({ byProject: { ...result.snapshot.projects } });
          persistWorkspace();
        }
        return result;
      };
      const dispatch = async (
        build: WorkspaceCommandBuilder,
        isCurrent?: () => boolean,
      ): Promise<void> => {
        const result = dispatchResult(build, isCurrent);
        if (result?.kind === "stale") throw new Error("Editor workspace command is stale");
      };

      return {
        byProject: {},
        _workspaceHydrated: false,
        _layoutPersistenceError: null,

        openTab: (projectId, input, isCurrent, editorWorkId) => {
          if (isCurrent?.() === false) return { kind: "superseded" };
          if (!isEditorContextTab(input)) return { kind: "ineligible" };
          const tab = { ...input, tabInstanceId: input.tabInstanceId ?? crypto.randomUUID() };
          dispatchResult(() => ({ kind: "open", projectId, tab }), isCurrent);
          const installed = sliceFor(get(), projectId).tabs.find(
            (member) => member.documentId === tab.documentId,
          );
          // Another Work's draft-only tab is not this Editor's document.
          return installed &&
            (editorWorkId === undefined ||
              !isDraftOnly(installed) ||
              reviewEntryOf(installed, editorWorkId) !== undefined)
            ? { kind: "opened", tab: installed }
            : { kind: "not-opened" };
        },

        reconcileResourceTab: (projectId, resourceHandle, tab) =>
          dispatch(() => ({ kind: "reconcile-resource", projectId, resourceHandle, tab })),

        updateTrackedTab: (projectId, addressed, metadata) =>
          dispatch((base) => {
            const tab = sliceFor(base, projectId).tabs.find(
              (candidate): candidate is Extract<ContextTab, { kind: "tracked" }> =>
                candidate.kind === "tracked" && matchesTabInstance(candidate, addressed),
            );
            return tab
              ? { kind: "open", projectId, tab: { ...tab, ...metadata } as typeof tab }
              : null;
          }),

        reorderTabs: (projectId, fromIndex, toIndex) =>
          dispatch((base) => {
            const tabs = sliceFor(base, projectId).tabs;
            if (
              fromIndex === toIndex ||
              fromIndex < 0 ||
              toIndex < 0 ||
              fromIndex >= tabs.length ||
              toIndex >= tabs.length
            )
              return null;
            const next = tabs.map((tab) => tab.tabInstanceId as string);
            const [moved] = next.splice(fromIndex, 1);
            next.splice(toIndex, 0, moved);
            return {
              kind: "reorder",
              projectId,
              expectedTabInstanceIds: tabs.map((tab) => tab.tabInstanceId as string),
              nextTabInstanceIds: next,
            };
          }),

        selectTab: (projectId, workId, documentId, addressed) => {
          if (
            addressed &&
            !sliceFor(get(), projectId).tabs.some((tab) => matchesTabInstance(tab, addressed))
          )
            return Promise.resolve();
          return dispatch((base) => {
            const slice = sliceFor(base, projectId);
            const tabInstanceId =
              documentId === null
                ? null
                : slice.tabs.find((tab) => tab.documentId === documentId)?.tabInstanceId;
            return documentId !== null && !tabInstanceId
              ? null
              : { kind: "select", projectId, workId, tabInstanceId: tabInstanceId ?? null };
          });
        },

        reconcileBootstrap: async (projectId, changes) => {
          await dispatch(() => ({
            kind: "reconcile-bootstrap",
            projectId,
            changes: changes.filter(({ prior }) => !isDraftOnly(prior)),
          }));
        },

        applyAvailability: (projectId, prior, next) =>
          dispatch(() => {
            const durablePrior = prior;
            const durableNext = next;
            const unmatched = new Set(durablePrior.tabs.map((_tab, index) => index));
            const updates = durableNext.tabs.flatMap((tab) => {
              const index = [...unmatched].find((candidateIndex) => {
                const candidate = durablePrior.tabs[candidateIndex];
                return (
                  candidate?.tabInstanceId === tab.tabInstanceId ||
                  candidate?.documentId === tab.documentId
                );
              });
              if (index === undefined) return [];
              unmatched.delete(index);
              const candidate = durablePrior.tabs[index] as ContextTab;
              return JSON.stringify(candidate) !== JSON.stringify(tab)
                ? [{ prior: candidate, next: tab }]
                : [];
            });
            const keys = new Set([
              ...Object.keys(durablePrior.selectedTabIdByWork),
              ...Object.keys(durableNext.selectedTabIdByWork),
            ]);
            return {
              kind: "apply-availability",
              projectId,
              removals: [...unmatched].map((index) => durablePrior.tabs[index] as ContextTab),
              updates,
              selections: [...keys].flatMap((workId) => {
                const priorDocumentId = durablePrior.selectedTabIdByWork[workId] ?? null;
                const nextDocumentId = durableNext.selectedTabIdByWork[workId] ?? null;
                return priorDocumentId === nextDocumentId
                  ? []
                  : [{ workId, priorDocumentId, nextDocumentId }];
              }),
            };
          }),

        dropReviewEntry: (projectId, workId, tabInstanceId) => {
          dispatchResult(() => ({ kind: "drop-review", projectId, workId, tabInstanceId }));
        },

        settleDraft: async (projectId, tab) => {
          if (tab.kind === "new") return { kind: "not-settled" };
          const result = dispatchResult(() => ({ kind: "settle-draft", projectId, tab }));
          return result?.kind === "committed" || result?.kind === "already-committed"
            ? { kind: "settled" }
            : { kind: "not-settled" };
        },
      };
    },
    { name: "context-tabs-store", enabled: import.meta.env.DEV },
  ),
);

export function reconcileEditorWorkspaceBootstrap(
  projectId: string,
  changes: readonly { prior: ContextTab; next: ContextTab | null }[],
): Promise<void> {
  return useContextTabsStore.getState().reconcileBootstrap(projectId, changes);
}

export function commitContextAvailability(
  projectId: string,
  prior: ProjectTabsSlice,
  next: ProjectTabsSlice,
): Promise<void> | void {
  const hydrated = useContextTabsStore.getState()._workspaceHydrated && workspaceAccountId !== null;
  const settlement = useContextTabsStore
    .getState()
    .applyAvailability(projectId, durableSlice(prior), durableSlice(next));
  return hydrated ? settlement : undefined;
}

/** Coordinator-only exact represented removal. */
export function commitPlannedContextRemoval(
  projectId: string,
  input: {
    documentIds: readonly string[];
    workspaceSelection?: { workId: string; documentId: string | null };
    /** A Work's Discard drops only its entry; the tab survives while another Work reviews it. */
    dropReviewOf?: string;
  },
): ContextTab[] {
  const documentIds = new Set(input.documentIds);
  const before = sliceFor(useContextTabsStore.getState(), projectId);
  const removed = before.tabs.filter((tab) => documentIds.has(tab.documentId));
  if (input.dropReviewOf) {
    for (const tab of removed)
      if (tab.tabInstanceId)
        useContextTabsStore
          .getState()
          .dropReviewEntry(projectId, input.dropReviewOf, tab.tabInstanceId);
  }
  const slice = sliceFor(useContextTabsStore.getState(), projectId);
  const tabs = input.dropReviewOf
    ? slice.tabs
    : slice.tabs.filter((tab) => !documentIds.has(tab.documentId));
  const selectedTabIdByWork = { ...slice.selectedTabIdByWork };
  if (input.workspaceSelection) {
    const { workId, documentId } = input.workspaceSelection;
    if (documentId === null) delete selectedTabIdByWork[workId];
    else selectedTabIdByWork[workId] = documentId;
  }
  void useContextTabsStore.getState().applyAvailability(projectId, slice, {
    tabs,
    selectedTabIdByWork: normalizeSelections(tabs, selectedTabIdByWork),
  });
  return removed;
}

/** Coordinator-only exact draft settlement: the draft-only tab becomes the ordinary tab in place. */
export function commitDraftApplyMetadata(
  projectId: string,
  tab: Extract<ContextTab, { kind: "tracked" }>,
): Promise<DraftWorkspaceSettlementReceipt> {
  return useContextTabsStore.getState().settleDraft(projectId, tab);
}

/** Selector helper — returns the tab slice for a project (stable empty default). */
export function useContextTabs(projectId: string): ProjectTabsSlice {
  return useContextTabsStore((state) => sliceFor(state, projectId));
}

/** Imperative view for route and coordinator ownership reads. */
export function getContextTabs(projectId: string): ProjectTabsSlice {
  return sliceFor(useContextTabsStore.getState(), projectId);
}

let workspaceAccountId: string | null = null;

function workspaceRecord(accountId: string) {
  return browserRecord(
    "session",
    { key: EDITOR_WORKSPACE_STORAGE_KEY, version: 1, accountId },
    parseEditorWorkspace,
    (error) => useContextTabsStore.setState({ _layoutPersistenceError: error }),
  );
}

function persistWorkspace(): void {
  if (!workspaceAccountId) return;
  const { byProject } = useContextTabsStore.getState();
  // A hidden draft's tab is not persisted: its address (document and item key) reopens it.
  const persisted = Object.fromEntries(
    Object.entries(byProject).map(([projectId, slice]) => [projectId, durableSlice(slice)]),
  );
  if (workspaceRecord(workspaceAccountId).write(persisted))
    useContextTabsStore.setState({ _layoutPersistenceError: null });
}

/** Restore this browser context once per account, never project another window's layout. */
export async function rehydrateEditorWorkspace(userId: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (workspaceAccountId === userId && useContextTabsStore.getState()._workspaceHydrated) return;
  useContextTabsStore.setState({ _layoutPersistenceError: null });
  const snapshot = workspaceRecord(userId).read();
  workspaceAccountId = userId;
  useContextTabsStore.setState({
    byProject: snapshot ? { ...snapshot } : {},
    _workspaceHydrated: true,
  });
}

type PublicContextTabsActions = Pick<
  ContextTabsActions,
  "openTab" | "reconcileResourceTab" | "updateTrackedTab" | "reorderTabs" | "selectTab"
>;

export function useContextTabsActions(): PublicContextTabsActions {
  return useContextTabsStore(
    useShallow((s) => ({
      openTab: s.openTab,
      reconcileResourceTab: s.reconcileResourceTab,
      updateTrackedTab: s.updateTrackedTab,
      reorderTabs: s.reorderTabs,
      selectTab: s.selectTab,
    })),
  );
}
