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
import {
  CONTEXT_DESK_STORAGE_KEY,
  type DeviceContextDeskCommand,
  DeviceContextDeskLedger,
  parseContextDesk,
  reduceContextDesk,
} from "./context-desk-storage";
export type ContextTab =
  | {
      tabInstanceId?: string;
      kind: "tracked";
      documentId: string;
      scheme: ProjectContextTreeScheme;
      path: string;
      name: string;
      workId?: string;
      draftOnly?: boolean;
      /** Transient owner of a draft-synthesized review tab; never persisted. */
      reviewWorkId?: string;
      /** Transient exact draft and tab-generation fence for post-Apply settlement. */
      reviewDraftId?: string;
      tabInstanceToken?: string;
      editable: true;
      filetype: Filetype;
      schemaType: YjsTrackedSchemaType;
      provisionalName?: boolean;
      /** Device provenance retained after a local Untitled materializes. */
      origin?: "local-untitled";
    }
  | {
      tabInstanceId?: string;
      kind: "viewer";
      documentId: string;
      scheme: ProjectContextTreeScheme;
      path: string;
      name: string;
      workId?: string;
      draftOnly?: boolean;
      /** Transient owner of a draft-synthesized review tab; never persisted. */
      reviewWorkId?: string;
      reviewDraftId?: string;
      tabInstanceToken?: string;
      editable: false;
      fileType: DocumentFileType;
      mimeType?: string;
    }
  | {
      tabInstanceId?: string;
      kind: "new";
      documentId: string;
      name: string;
      /** Canonical Work owner captured when the local Scratch document is created. */
      workId: string;
      lineageHandle?: string;
      identityRevision?: number;
      draftOnly?: boolean;
    };

export type ServerContextTab = Extract<ContextTab, { kind: "tracked" | "viewer" }>;

export type ProjectTabsSlice = {
  tabs: ContextTab[];
  selectedTabIdByWork: Record<string, string>;
};

type ContextTabsState = {
  /** Durable projectId → slice. Replaced only by desk ledger projections. */
  byProject: Record<string, ProjectTabsSlice>;
  /** Review-only tabs and route intent. Never supplied to a durable desk command. */
  _reviewOverlayByProject: Record<string, ProjectTabsSlice>;
  _deskHydrated: boolean;
  _deskRevision: number;
};

type ContextTabsActions = {
  openTab: (projectId: string, tab: ContextTab) => Promise<void>;
  remintNewTab: (projectId: string, documentId: string, replacementId: string) => Promise<void>;
  materializeNewTab: (
    projectId: string,
    documentId: string,
    tab: Extract<ContextTab, { kind: "tracked" }>,
  ) => Promise<void>;
  updateTrackedTab: (
    projectId: string,
    documentId: string,
    metadata: Partial<Extract<ContextTab, { kind: "tracked" }>>,
  ) => Promise<void>;
  reorderTabs: (projectId: string, fromIndex: number, toIndex: number) => Promise<void>;
  selectTab: (projectId: string, workId: string, documentId: string | null) => Promise<void>;
  reconcileBootstrap: (
    projectId: string,
    priorTabs: readonly ContextTab[],
    nextTabs: readonly ContextTab[],
  ) => Promise<void>;
  applyAvailability: (
    projectId: string,
    prior: ProjectTabsSlice,
    next: ProjectTabsSlice,
  ) => Promise<void>;
  settleDraft: (
    projectId: string,
    tab: ContextTab,
    disposition: "applied" | "discarded",
  ) => Promise<DraftDeskSettlementReceipt>;
  consumeReviewTab: (
    projectId: string,
    identity: ReviewOverlayTabIdentity,
  ) => ReviewOverlayConsumeReceipt;
};

export type DraftDeskSettlementReceipt = { kind: "settled" } | { kind: "not-settled" };

export type ReviewOverlayConsumeReceipt =
  | { kind: "consumed"; current: ProjectTabsSlice }
  | { kind: "not-consumed"; current: ProjectTabsSlice };

export type ReviewOverlayTabIdentity = {
  documentId: string;
  tabInstanceId: string;
  reviewWorkId: string;
  reviewDraftId: string;
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

export function contextTabMayBeSelectedForWork(tab: ContextTab, workId: string): boolean {
  return tab.kind === "new" || tab.scheme === "scratch" || tab.scheme === "uploads"
    ? tab.workId === workId
    : true;
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

function durableSlice(slice: ProjectTabsSlice): ProjectTabsSlice {
  const tabs = slice.tabs.filter((tab) => !tab.draftOnly);
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
  const overlayIds = new Set(overlay.tabs.map((tab) => tab.documentId));
  const composed = {
    tabs: [...durable.tabs.filter((tab) => !overlayIds.has(tab.documentId)), ...overlay.tabs],
    selectedTabIdByWork: {
      ...durable.selectedTabIdByWork,
      ...overlay.selectedTabIdByWork,
    },
  };
  composedSliceCache.set(projectId, { durable, overlay, composed });
  return composed;
}

type DeskCommandBuilder = (
  state: ContextTabsState & ContextTabsActions,
) => DeviceContextDeskCommand | null;

function projectSnapshot(snapshot: {
  projects: Readonly<Record<string, ProjectTabsSlice>>;
  deskRevision: number;
}): Pick<ContextTabsState, "byProject" | "_deskHydrated" | "_deskRevision"> {
  return {
    byProject: { ...snapshot.projects },
    _deskHydrated: true,
    _deskRevision: snapshot.deskRevision,
  };
}

export const useContextTabsStore = create<ContextTabsState & ContextTabsActions>()(
  devtools(
    (rawSet, get) => {
      const dispatchResult = async (build: DeskCommandBuilder) => {
        const current = get();
        const command = build(current);
        if (!command) return null;
        if (!current._deskHydrated || !deviceDesk) {
          const reduced = reduceContextDesk(
            {
              version: 3,
              accountId: "unhydrated",
              deskRevision: current._deskRevision,
              projects: current.byProject,
            },
            command,
          );
          if (reduced.kind === "committed") rawSet(projectSnapshot(reduced.snapshot));
          return reduced;
        }
        const ledger = deviceDesk;
        const result = await ledger.apply(command);
        const mounted = get();
        if (
          deviceDesk === ledger &&
          result.snapshot.accountId === ledger.accountId &&
          result.snapshot.deskRevision >= mounted._deskRevision
        )
          rawSet(projectSnapshot(result.snapshot));
        return result;
      };
      const dispatch = (build: DeskCommandBuilder): Promise<void> =>
        dispatchResult(build).then(() => undefined);

      return {
        byProject: {},
        _reviewOverlayByProject: {},
        _deskHydrated: false,
        _deskRevision: 0,

        openTab: (projectId, input) => {
          const tab = { ...input, tabInstanceId: input.tabInstanceId ?? crypto.randomUUID() };
          if (tab.draftOnly) {
            rawSet((base) => {
              const overlay = base._reviewOverlayByProject[projectId] ?? emptySlice();
              const index = overlay.tabs.findIndex(
                (candidate) => candidate.documentId === tab.documentId,
              );
              const existing = index < 0 ? undefined : overlay.tabs[index];
              const mounted =
                existing && existing.kind !== "new" && existing.draftOnly
                  ? ({
                      ...existing,
                      ...tab,
                      tabInstanceId: existing.tabInstanceId,
                      reviewWorkId: existing.reviewWorkId,
                      reviewDraftId: existing.reviewDraftId,
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
            return Promise.resolve();
          }
          return dispatch(
            (base) =>
              ({
                kind: tab.kind === "new" ? "install-local" : "open",
                projectId,
                ...(tab.kind === "new" ? { expectedDeskRevision: base._deskRevision } : {}),
                tab,
              }) as DeviceContextDeskCommand,
          );
        },

        remintNewTab: (projectId, documentId, replacementId) =>
          dispatch((base) => {
            const tab = sliceFor(base, projectId).tabs.find(
              (candidate) => candidate.kind === "new" && candidate.documentId === documentId,
            );
            if (tab?.kind !== "new" || !tab.lineageHandle) return null;
            return {
              kind: "publish-remint",
              lineageHandle: tab.lineageHandle,
              minimumIdentityRevision: (tab.identityRevision ?? 0) + 1,
              documentId: replacementId,
            };
          }),

        materializeNewTab: (projectId, documentId, tab) =>
          dispatch((base) => {
            const local = sliceFor(base, projectId).tabs.find(
              (candidate) => candidate.kind === "new" && candidate.documentId === documentId,
            );
            if (local?.kind !== "new" || !local.lineageHandle) return null;
            return {
              kind: "publish-adoption",
              lineageHandle: local.lineageHandle,
              adoptionRevision: (local.identityRevision ?? 1) + 1,
              trackedTab: { ...tab, origin: "local-untitled" },
            };
          }),

        updateTrackedTab: (projectId, documentId, metadata) =>
          dispatch((base) => {
            const tab = sliceFor(base, projectId).tabs.find(
              (candidate): candidate is Extract<ContextTab, { kind: "tracked" }> =>
                candidate.kind === "tracked" && candidate.documentId === documentId,
            );
            return tab ? { kind: "open", projectId, tab: { ...tab, ...metadata } } : null;
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

        selectTab: (projectId, workId, documentId) => {
          const overlay = get()._reviewOverlayByProject[projectId];
          if (
            documentId !== null &&
            overlay?.tabs.some(
              (tab) => tab.documentId === documentId && contextTabMayBeSelectedForWork(tab, workId),
            )
          ) {
            rawSet((base) => ({
              _reviewOverlayByProject: {
                ...base._reviewOverlayByProject,
                [projectId]: {
                  ...(base._reviewOverlayByProject[projectId] ?? emptySlice()),
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
              return {
                _reviewOverlayByProject: {
                  ...base._reviewOverlayByProject,
                  [projectId]: { ...current, selectedTabIdByWork },
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

        reconcileBootstrap: async (projectId, priorTabs, nextTabs) => {
          await dispatch(() => ({
            kind: "reconcile-bootstrap",
            projectId,
            priorTabs: priorTabs.filter((tab) => !tab.draftOnly),
            nextTabs: nextTabs.filter((tab) => !tab.draftOnly),
          }));
          for (const tab of nextTabs) if (tab.draftOnly) await get().openTab(projectId, tab);
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

        settleDraft: async (projectId, tab, disposition) => {
          if (tab.kind === "new") return { kind: "not-settled" };
          const result = await dispatchResult(() => ({
            kind: "settle-draft",
            projectId,
            tab,
            disposition,
          }));
          return result?.kind === "committed" || result?.kind === "already-committed"
            ? { kind: "settled" }
            : { kind: "not-settled" };
        },

        consumeReviewTab: (projectId, identity) => {
          let consumed = false;
          let current: ProjectTabsSlice | null = null;
          rawSet((base) => {
            const overlay = base._reviewOverlayByProject[projectId];
            if (!overlay) {
              current = composeProjectSlice(base, projectId);
              return {};
            }
            const tabs = overlay.tabs.filter((candidate) => {
              const matches =
                candidate.kind !== "new" &&
                candidate.draftOnly &&
                candidate.documentId === identity.documentId &&
                candidate.tabInstanceId === identity.tabInstanceId &&
                candidate.reviewWorkId === identity.reviewWorkId &&
                candidate.reviewDraftId === identity.reviewDraftId &&
                candidate.tabInstanceToken === identity.tabInstanceToken;
              if (matches) consumed = true;
              return !matches;
            });
            if (!consumed) {
              current = composeProjectSlice(base, projectId);
              return {};
            }
            const durableTabs = sliceFor(base, projectId).tabs;
            const selectedTabIdByWork = normalizeSelections(
              [
                ...durableTabs.filter(
                  (durable) => !tabs.some((tab) => tab.documentId === durable.documentId),
                ),
                ...tabs,
              ],
              overlay.selectedTabIdByWork,
            );
            const next = { ...base._reviewOverlayByProject };
            if (tabs.length === 0 && Object.keys(selectedTabIdByWork).length === 0)
              delete next[projectId];
            else next[projectId] = { tabs, selectedTabIdByWork };
            const update = { _reviewOverlayByProject: next };
            current = composeProjectSlice({ ...base, ...update }, projectId);
            return update;
          });
          const authoritative = current ?? composeProjectSlice(get(), projectId);
          return consumed
            ? { kind: "consumed", current: authoritative }
            : { kind: "not-consumed", current: authoritative };
        },
      };
    },
    { name: "context-tabs-store", enabled: import.meta.env.DEV },
  ),
);

export function reconcileContextDeskBootstrap(
  projectId: string,
  priorTabs: readonly ContextTab[],
  nextTabs: readonly ContextTab[],
): Promise<void> {
  return useContextTabsStore.getState().reconcileBootstrap(projectId, priorTabs, nextTabs);
}

export function commitContextAvailability(
  projectId: string,
  prior: ProjectTabsSlice,
  next: ProjectTabsSlice,
): Promise<void> | void {
  const hydrated = useContextTabsStore.getState()._deskHydrated && deviceDesk !== null;
  const settlement = useContextTabsStore.getState().applyAvailability(projectId, prior, next);
  return hydrated ? settlement : undefined;
}

/** Coordinator-only exact represented removal. */
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
  const tabs = slice.tabs.filter((tab) => !documentIds.has(tab.documentId));
  const selectedTabIdByWork = { ...slice.selectedTabIdByWork };
  if (input.deskSelection) {
    const { workId, documentId } = input.deskSelection;
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
  disposition: "applied" | "discarded" = "applied",
): Promise<DraftDeskSettlementReceipt> {
  const tab = useContextTabsStore
    .getState()
    ._reviewOverlayByProject[projectId]?.tabs.find(
      (candidate) =>
        candidate.documentId === identity.documentId &&
        candidate.kind === "tracked" &&
        candidate.draftOnly &&
        candidate.tabInstanceId === identity.tabInstanceId &&
        candidate.reviewWorkId === identity.reviewWorkId &&
        candidate.reviewDraftId === identity.reviewDraftId &&
        candidate.tabInstanceToken === identity.tabInstanceToken,
    );
  if (!tab) return Promise.resolve({ kind: "not-settled" });
  return useContextTabsStore.getState().settleDraft(projectId, tab, disposition);
}

/** Explicit-close-only exact review overlay consumption. Never dispatches to the durable desk. */
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

let deviceDesk: DeviceContextDeskLedger | null = null;
let storageProjectionInstalled = false;

function projectDeskSnapshot(snapshot: ReturnType<DeviceContextDeskLedger["snapshot"]>): void {
  if (snapshot.deskRevision <= useContextTabsStore.getState()._deskRevision) return;
  useContextTabsStore.setState({
    byProject: { ...snapshot.projects },
    _deskHydrated: true,
    _deskRevision: snapshot.deskRevision,
  });
}

/** Establishes the desired account's durable desk before its workspace is revealed. */
export async function rehydrateContextDesks(userId: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (!storageProjectionInstalled) {
    window.addEventListener("storage", (event) => {
      if (event.key !== CONTEXT_DESK_STORAGE_KEY || !deviceDesk) return;
      const projected = deviceDesk.project(event.newValue);
      if (projected) projectDeskSnapshot(projected);
    });
    storageProjectionInstalled = true;
  }
  const durable = parseContextDesk(localStorage.getItem(CONTEXT_DESK_STORAGE_KEY));
  const activeAccountId = deviceDesk?.accountId ?? null;
  const resetFromAccountId =
    activeAccountId !== null && activeAccountId !== userId
      ? activeAccountId
      : durable && durable.accountId !== userId
        ? durable.accountId
        : null;
  if (resetFromAccountId) {
    const previous =
      deviceDesk?.accountId === resetFromAccountId
        ? deviceDesk
        : new DeviceContextDeskLedger(localStorage, resetFromAccountId);
    useContextTabsStore.setState({
      byProject: {},
      _reviewOverlayByProject: {},
      _deskHydrated: false,
      _deskRevision: 0,
    });
    const settled = await previous.apply({
      kind: "reset-account",
      expectedAccountId: resetFromAccountId,
      nextAccountId: userId,
    });
    if (
      (settled.kind !== "committed" && settled.kind !== "already-committed") ||
      settled.snapshot.accountId !== userId
    )
      throw new Error("Context desk account transition is stale");
    deviceDesk = new DeviceContextDeskLedger(localStorage, userId);
    useContextTabsStore.setState(projectSnapshot(deviceDesk.snapshot()));
    return;
  }
  if (!deviceDesk || deviceDesk.accountId !== userId)
    deviceDesk = new DeviceContextDeskLedger(localStorage, userId);
  const byProject = { ...deviceDesk.snapshot().projects };
  useContextTabsStore.setState({
    byProject,
    _deskHydrated: true,
    _deskRevision: deviceDesk.snapshot().deskRevision,
  });
  // Rewrites stale exclusions immediately, including completed untitleds.
}

async function applyPublication(
  command:
    | {
        kind: "publish-remint";
        lineageHandle: string;
        minimumIdentityRevision: number;
        documentId: string;
      }
    | {
        kind: "publish-adoption";
        lineageHandle: string;
        adoptionRevision: number;
        trackedTab: ContextTab;
      },
): Promise<"published" | "not-referenced" | "stale"> {
  if (!deviceDesk) throw new Error("Context desk is not hydrated");
  const result = await deviceDesk.apply(command);
  if (result.kind === "stale") return "stale";
  if (result.kind === "not-referenced") return "not-referenced";
  if (result.snapshot.deskRevision > useContextTabsStore.getState()._deskRevision) {
    useContextTabsStore.setState({
      byProject: { ...result.snapshot.projects },
      _deskHydrated: true,
      _deskRevision: result.snapshot.deskRevision,
    });
  }
  return "published";
}

export function publishLocalUntitledRemint(input: {
  lineageHandle: string;
  minimumIdentityRevision: number;
  documentId: string;
}): Promise<"published" | "not-referenced" | "stale"> {
  return applyPublication({ kind: "publish-remint", ...input });
}

export function publishLocalUntitledAdoption(input: {
  lineageHandle: string;
  adoptionRevision: number;
  trackedTab: ContextTab;
}): Promise<"published" | "not-referenced" | "stale"> {
  return applyPublication({ kind: "publish-adoption", ...input });
}

type PublicContextTabsActions = Pick<
  ContextTabsActions,
  | "openTab"
  | "remintNewTab"
  | "materializeNewTab"
  | "updateTrackedTab"
  | "reorderTabs"
  | "selectTab"
>;

export function useContextTabsActions(): PublicContextTabsActions {
  return useContextTabsStore(
    useShallow((s) => ({
      openTab: s.openTab,
      remintNewTab: s.remintNewTab,
      materializeNewTab: s.materializeNewTab,
      updateTrackedTab: s.updateTrackedTab,
      reorderTabs: s.reorderTabs,
      selectTab: s.selectTab,
    })),
  );
}
