/** Browser-context-local Editor membership. Zustand owns live state; sessionStorage restores it. */
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import { browserRecord } from "@/client/storage/browser-record";
import {
  type ContextTab,
  isEditorContextTab,
  isEditorTab,
  matchesReviewItem,
  matchesTabInstance,
  type ProjectTabsSlice,
  type ReviewItemTabIdentity,
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
  Omit<
    Extract<ContextTab, { kind: "tracked" }>,
    | keyof TabOwner
    | "tabInstanceId"
    | "draftOnly"
    | "reviewWorkId"
    | "reviewItemKey"
    | "tabInstanceToken"
  >
> &
  TabOwner;

export {
  type ContextTab,
  editorTabsForWork,
  isEditorContextTab,
  isEditorScheme,
  isEditorTab,
  matchesReviewItem,
  matchesTabInstance,
  type ProjectTabsSlice,
  type ReviewItemTabIdentity,
  replaceOwner,
  type ServerContextTab,
  type TabOwner,
  tabContextOwner,
} from "./editor-workspace-model";

type ContextTabsState = {
  /** Live project membership, independent of other browser contexts. */
  byProject: Record<string, ProjectTabsSlice>;
  /** Review-only tabs and route intent. Never supplied to a browser-local workspace command. */
  _reviewOverlayByProject: Record<string, ProjectTabsSlice>;
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
  consumeReviewTab: (
    projectId: string,
    identity: ReviewOverlayTabIdentity,
  ) => ReviewOverlayConsumeReceipt;
};

export type DraftWorkspaceSettlementReceipt = { kind: "settled" } | { kind: "not-settled" };

export type ReviewOverlayConsumeReceipt =
  | { kind: "consumed"; current: ProjectTabsSlice }
  | { kind: "not-consumed"; current: ProjectTabsSlice };

export type ReviewOverlayTabIdentity = ReviewItemTabIdentity & {
  tabInstanceId: string;
  tabInstanceToken: string;
};

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
  const tabs = slice.tabs.filter((tab) => !tab.draftOnly && isEditorContextTab(tab));
  return { tabs, selectedTabIdByWork: normalizeSelections(tabs, slice.selectedTabIdByWork) };
}

function sliceFor(state: ContextTabsState, projectId: string): ProjectTabsSlice {
  return state.byProject[projectId] ?? emptySlice();
}

const composedSliceCache = new Map<
  string,
  { durable: ProjectTabsSlice; overlay: ProjectTabsSlice; composed: ProjectTabsSlice }
>();

function composeProjectSlice(state: ContextTabsState, projectId: string): ProjectTabsSlice {
  const durable = sliceFor(state, projectId);
  const overlay = state._reviewOverlayByProject?.[projectId];
  if (!overlay) return durable;
  const cached = composedSliceCache.get(projectId);
  if (cached?.durable === durable && cached.overlay === overlay) return cached.composed;
  const composed = composeSlices(durable, overlay);
  composedSliceCache.set(projectId, { durable, overlay, composed });
  return composed;
}

function sameReviewOverlay(left: ContextTab, right: ContextTab): boolean {
  return (
    right.kind !== "new" &&
    matchesReviewItem(left, {
      reviewWorkId: right.reviewWorkId ?? "",
      reviewItemKey: right.reviewItemKey ?? "",
    })
  );
}

function composeSlices(durable: ProjectTabsSlice, overlay?: ProjectTabsSlice): ProjectTabsSlice {
  if (!overlay) return durable;
  return {
    tabs: [...durable.tabs, ...overlay.tabs],
    selectedTabInstanceIdByWork: overlay.selectedTabInstanceIdByWork,
    selectedTabIdByWork: {
      ...durable.selectedTabIdByWork,
      ...overlay.selectedTabIdByWork,
    },
  };
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
        _reviewOverlayByProject: {},
        _workspaceHydrated: false,
        _layoutPersistenceError: null,

        openTab: (projectId, input, isCurrent, editorWorkId) => {
          if (isCurrent?.() === false) return { kind: "superseded" };
          if (!isEditorContextTab(input)) return { kind: "ineligible" };
          const tab = { ...input, tabInstanceId: input.tabInstanceId ?? crypto.randomUUID() };
          const reviewOverlayTab = get()._reviewOverlayByProject[projectId]?.tabs.find(
            (candidate) =>
              candidate.documentId === tab.documentId &&
              candidate.draftOnly &&
              (!tab.draftOnly || sameReviewOverlay(candidate, tab)),
          );
          if (tab.draftOnly) {
            rawSet((base) => {
              const overlay = base._reviewOverlayByProject[projectId] ?? emptySlice();
              const index = overlay.tabs.findIndex((candidate) =>
                sameReviewOverlay(candidate, tab),
              );
              const existing = index < 0 ? undefined : overlay.tabs[index];
              const mounted =
                existing && existing.kind !== "new" && existing.draftOnly
                  ? ({
                      ...existing,
                      ...tab,
                      tabInstanceId: existing.tabInstanceId,
                      reviewWorkId: existing.reviewWorkId,
                      reviewItemKey: existing.reviewItemKey,
                      tabInstanceToken: existing.tabInstanceToken,
                    } as ContextTab)
                  : tab;
              const tabs =
                index < 0
                  ? [...overlay.tabs, mounted]
                  : overlay.tabs.map((candidate, candidateIndex) =>
                      candidateIndex === index
                        ? ({
                            ...candidate,
                            ...mounted,
                            tabInstanceId: candidate.tabInstanceId,
                          } as ContextTab)
                        : candidate,
                    );
              return {
                _reviewOverlayByProject: {
                  ...base._reviewOverlayByProject,
                  [projectId]: { ...overlay, tabs },
                },
              };
            });
          } else if (reviewOverlayTab) {
            // Readable-address resolution enriches the transient review tab
            // with its live resource identity, not a durable shadow: a
            // reserved draft document is not proof of live catalog membership.
            rawSet((base) => {
              const overlay = base._reviewOverlayByProject[projectId] ?? emptySlice();
              return {
                _reviewOverlayByProject: {
                  ...base._reviewOverlayByProject,
                  [projectId]: {
                    ...overlay,
                    tabs: overlay.tabs.map((candidate) =>
                      candidate.documentId === tab.documentId && candidate.draftOnly
                        ? ({
                            ...candidate,
                            ...tab,
                            tabInstanceId: candidate.tabInstanceId,
                            draftOnly: candidate.draftOnly,
                            reviewWorkId:
                              candidate.kind !== "new" ? candidate.reviewWorkId : undefined,
                            reviewItemKey:
                              candidate.kind !== "new" ? candidate.reviewItemKey : undefined,
                            tabInstanceToken:
                              candidate.kind !== "new" ? candidate.tabInstanceToken : undefined,
                          } as ContextTab)
                        : candidate,
                    ),
                  },
                },
              };
            });
          } else {
            dispatchResult(() => ({ kind: "open", projectId, tab }), isCurrent);
          }
          const candidates = composeProjectSlice(get(), projectId).tabs.filter(
            (member) =>
              member.documentId === tab.documentId &&
              (tab.draftOnly
                ? sameReviewOverlay(member, tab)
                : !member.draftOnly ||
                  editorWorkId === undefined ||
                  (member.kind !== "new" && member.reviewWorkId === editorWorkId)),
          );
          // A plain resource read may enrich several reviews; it cannot choose one.
          const installed =
            candidates.find((member) => !member.draftOnly) ??
            (candidates.length === 1 ? candidates[0] : undefined);
          return installed ? { kind: "opened", tab: installed } : { kind: "not-opened" };
        },

        reconcileResourceTab: (projectId, resourceHandle, tab) =>
          dispatch(() => ({ kind: "reconcile-resource", projectId, resourceHandle, tab })),

        updateTrackedTab: async (projectId, addressed, metadata) => {
          if (addressed.draftOnly) {
            rawSet((base) => {
              const overlay = base._reviewOverlayByProject[projectId];
              if (!overlay) return {};
              return {
                _reviewOverlayByProject: {
                  ...base._reviewOverlayByProject,
                  [projectId]: {
                    ...overlay,
                    tabs: overlay.tabs.map((tab) =>
                      tab.kind === "tracked" && matchesTabInstance(tab, addressed)
                        ? ({ ...tab, ...metadata } as ContextTab)
                        : tab,
                    ),
                  },
                },
              };
            });
            return;
          }
          await dispatch((base) => {
            const tab = sliceFor(base, projectId).tabs.find(
              (candidate): candidate is Extract<ContextTab, { kind: "tracked" }> =>
                candidate.kind === "tracked" && matchesTabInstance(candidate, addressed),
            );
            return tab
              ? { kind: "open", projectId, tab: { ...tab, ...metadata } as typeof tab }
              : null;
          });
        },

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
          const overlay = get()._reviewOverlayByProject[projectId];
          const selectedOverlay = overlay?.tabs.find(
            (tab) =>
              tab.documentId === documentId &&
              isEditorTab(tab, workId) &&
              (addressed ? matchesTabInstance(tab, addressed) : true),
          );
          if (
            addressed &&
            !composeProjectSlice(get(), projectId).tabs.some((tab) =>
              matchesTabInstance(tab, addressed),
            )
          )
            return Promise.resolve();
          if (documentId !== null && selectedOverlay) {
            rawSet((base) => ({
              _reviewOverlayByProject: {
                ...base._reviewOverlayByProject,
                [projectId]: {
                  ...(base._reviewOverlayByProject[projectId] ?? emptySlice()),
                  selectedTabInstanceIdByWork: {
                    ...overlay?.selectedTabInstanceIdByWork,
                    [workId]: selectedOverlay.tabInstanceId as string,
                  },
                  selectedTabIdByWork: {
                    ...(base._reviewOverlayByProject[projectId]?.selectedTabIdByWork ?? {}),
                    [workId]: documentId,
                  },
                },
              },
            }));
            return Promise.resolve();
          }
          if (overlay?.selectedTabIdByWork[workId]) {
            rawSet((base) => {
              const current = base._reviewOverlayByProject[projectId];
              if (!current?.selectedTabIdByWork[workId]) return {};
              const selectedTabIdByWork = { ...current.selectedTabIdByWork };
              delete selectedTabIdByWork[workId];
              const selectedTabInstanceIdByWork = { ...current.selectedTabInstanceIdByWork };
              delete selectedTabInstanceIdByWork[workId];
              return {
                _reviewOverlayByProject: {
                  ...base._reviewOverlayByProject,
                  [projectId]: { ...current, selectedTabIdByWork, selectedTabInstanceIdByWork },
                },
              };
            });
          }
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
            changes: changes.filter(({ prior }) => !prior.draftOnly),
          }));
        },

        applyAvailability: (projectId, prior, next) =>
          dispatch(() => {
            const durablePrior = durableSlice(prior);
            const durableNext = durableSlice(next);
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

        settleDraft: async (projectId, tab) => {
          if (tab.kind === "new") return { kind: "not-settled" };
          const result = await dispatchResult(() => ({
            kind: "settle-draft",
            projectId,
            tab,
          }));
          return result?.kind === "committed" || result?.kind === "already-committed"
            ? { kind: "settled" }
            : { kind: "not-settled" };
        },

        consumeReviewTab: (projectId, identity) => {
          const result = planReviewOverlayClose(get(), projectId, identity);
          rawSet(result.update);
          return { kind: result.consumed ? "consumed" : "not-consumed", current: result.current };
        },
      };
    },
    { name: "context-tabs-store", enabled: import.meta.env.DEV },
  ),
);

function planReviewOverlayClose(
  base: ContextTabsState,
  projectId: string,
  identity: ReviewOverlayTabIdentity,
) {
  let consumed = false;
  let current: ProjectTabsSlice;
  const overlay = base._reviewOverlayByProject[projectId];
  if (!overlay) {
    current = composeProjectSlice(base, projectId);
    return { update: {}, current, consumed };
  }
  const tabs = overlay.tabs.filter((candidate) => {
    const matches =
      candidate.kind !== "new" &&
      candidate.draftOnly &&
      candidate.tabInstanceId === identity.tabInstanceId &&
      candidate.reviewWorkId === identity.reviewWorkId &&
      candidate.reviewItemKey === identity.reviewItemKey &&
      candidate.tabInstanceToken === identity.tabInstanceToken;
    if (matches) consumed = true;
    return !matches;
  });
  if (!consumed) {
    current = composeProjectSlice(base, projectId);
    return { update: {}, current, consumed };
  }
  const durableTabs = sliceFor(base, projectId).tabs;
  const selectedTabIdByWork = normalizeSelections(
    [...durableTabs, ...tabs],
    overlay.selectedTabIdByWork,
  );
  const next = { ...base._reviewOverlayByProject };
  if (tabs.length === 0 && Object.keys(selectedTabIdByWork).length === 0) delete next[projectId];
  else
    next[projectId] = {
      tabs,
      selectedTabIdByWork,
      selectedTabInstanceIdByWork: Object.fromEntries(
        Object.entries(overlay.selectedTabInstanceIdByWork ?? {}).filter(([workId, instanceId]) =>
          tabs.some((tab) => tab.tabInstanceId === instanceId && isEditorTab(tab, workId)),
        ),
      ),
    };
  const update = { _reviewOverlayByProject: next };
  current = composeSlices(sliceFor(base, projectId), next[projectId]);
  return { update, current, consumed };
}

export function previewReviewOverlayClose(
  projectId: string,
  identity: ReviewOverlayTabIdentity,
): ReviewOverlayConsumeReceipt {
  const result = planReviewOverlayClose(useContextTabsStore.getState(), projectId, identity);
  return { kind: result.consumed ? "consumed" : "not-consumed", current: result.current };
}

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
  const settlement = useContextTabsStore.getState().applyAvailability(projectId, prior, next);
  return hydrated ? settlement : undefined;
}

/** Coordinator-only exact represented removal. */
export function commitPlannedContextRemoval(
  projectId: string,
  input: {
    documentIds: readonly string[];
    workspaceSelection?: { workId: string; documentId: string | null };
  },
): ContextTab[] {
  const documentIds = new Set(input.documentIds);
  const slice = sliceFor(useContextTabsStore.getState(), projectId);
  const removed = slice.tabs.filter((tab) => documentIds.has(tab.documentId));
  const tabs = slice.tabs.filter((tab) => !documentIds.has(tab.documentId));
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

/** Coordinator-only exact draft settlement. */
export function commitDraftApplyMetadata(
  projectId: string,
  identity: ReviewOverlayTabIdentity,
): Promise<DraftWorkspaceSettlementReceipt> {
  const tab = useContextTabsStore
    .getState()
    ._reviewOverlayByProject[projectId]?.tabs.find(
      (candidate) =>
        candidate.kind === "tracked" &&
        candidate.draftOnly &&
        candidate.tabInstanceId === identity.tabInstanceId &&
        candidate.reviewWorkId === identity.reviewWorkId &&
        candidate.reviewItemKey === identity.reviewItemKey &&
        candidate.tabInstanceToken === identity.tabInstanceToken,
    );
  if (!tab) return Promise.resolve({ kind: "not-settled" });
  return useContextTabsStore.getState().settleDraft(projectId, tab);
}

/** Explicit-close-only exact review overlay consumption. Never dispatches to the browser-local workspace. */
export function commitReviewOverlayClose(
  projectId: string,
  identity: ReviewOverlayTabIdentity,
): ReviewOverlayConsumeReceipt {
  return useContextTabsStore.getState().consumeReviewTab(projectId, identity);
}

/** Selector helper — returns the tab slice for a project (stable empty default). */
export function useContextTabs(projectId: string): ProjectTabsSlice {
  return useContextTabsStore((state) => composeProjectSlice(state, projectId));
}

/** Imperative composed view for route and coordinator ownership reads. */
export function getContextTabs(projectId: string): ProjectTabsSlice {
  return composeProjectSlice(useContextTabsStore.getState(), projectId);
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
  if (workspaceRecord(workspaceAccountId).write(useContextTabsStore.getState().byProject))
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
    _reviewOverlayByProject: {},
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
