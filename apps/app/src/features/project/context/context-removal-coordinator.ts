/** Exact-identity desk, continuity, and route reconciliation for live removals. */

import {
  isWorkScopedProjectContextScheme,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";

import {
  type ContextTab,
  type ProjectTabsSlice,
  type ServerContextTab,
  useContextTabsStore,
} from "@/client/stores";
import {
  commitDraftApplyMetadata,
  commitPlannedContextRemoval,
} from "@/client/stores/context-tabs-store/context-tabs-store";
import {
  buildWorkingSetRoute,
  type ReconcileContextRoutesInput,
  readRecentRoutes,
  recentRouteForEditorWork,
  reconcileContextRoutes,
} from "@/client/working-set";
import {
  applyContextRepairIfCurrent,
  type ContextRouteRepair,
  type ContextRouteTarget,
  type ProjectSearch,
} from "../routing/project-route";
import {
  type ContextRemovalIntent,
  type ContextRemovalOutcome,
  type ContextRouteSelection,
  contextTabEligibleForRemoval,
  planContextRemoval,
  routeTargetForTab,
  workingSetRouteForTab,
} from "./context-removal-planner";
import { contextTabMatchesRoute } from "./context-tab-identity";

type ContextRemovalWorkingSetPort = {
  readRecentRoutes(projectId: string): WorkingSetRoute[];
  reconcileContextRoutes(projectId: string, input: ReconcileContextRoutesInput): WorkingSetRoute[];
};

export type ContextRemovalRoutePort = {
  readSearch(projectId: string): ProjectSearch;
  updateSearch(projectId: string, update: (latest: ProjectSearch) => ProjectSearch): void;
};

type DeskPort = {
  read(projectId: string): ProjectTabsSlice;
  commit(
    projectId: string,
    input: { documentIds: readonly string[]; activeTabId: string | null },
  ): ContextTab[];
  resolveDraftApply(projectId: string, reviewWorkId: string, documentId: string): void;
};

type DeferredRemoval = {
  intent: ContextRemovalIntent;
  resolve: (outcome: ContextRemovalOutcome) => void;
};

type CoordinatorProjectState = {
  selection: ContextRouteSelection;
  rememberedRoute: ContextRouteTarget | null;
  autoOpenBlock: {
    selectionRevision: number;
    locator: ContextRouteTarget | null;
    documentIds: readonly string[];
  } | null;
  deferred: Map<number, DeferredRemoval[]>;
  listeners: Set<() => void>;
  snapshot: ContextRemovalProjectSnapshot;
};

export type ContextRemovalProjectSnapshot = Pick<
  CoordinatorProjectState,
  "selection" | "rememberedRoute" | "autoOpenBlock"
>;

const EMPTY_SLICE: ProjectTabsSlice = { tabs: [], activeTabId: null };
const EMPTY_PROJECT_SNAPSHOT: ContextRemovalProjectSnapshot = {
  selection: { status: "none", revision: 0 },
  rememberedRoute: null,
  autoOpenBlock: null,
};

const productionDesk: DeskPort = {
  read: (projectId) => useContextTabsStore.getState().byProject[projectId] ?? EMPTY_SLICE,
  commit: commitPlannedContextRemoval,
  resolveDraftApply: commitDraftApplyMetadata,
};

const productionWorkingSet: ContextRemovalWorkingSetPort = {
  readRecentRoutes,
  reconcileContextRoutes,
};

export class ContextRemovalCoordinator {
  private readonly projects = new Map<string, CoordinatorProjectState>();
  private readonly routePorts = new Map<string, { token: symbol; port: ContextRemovalRoutePort }>();
  private accountId: string | null = null;
  private readonly fallbackRoute: ContextRemovalRoutePort | null;
  private readonly desk: DeskPort;
  private readonly workingSet: ContextRemovalWorkingSetPort;

  constructor(
    dependencies: {
      desk?: DeskPort;
      workingSet?: ContextRemovalWorkingSetPort;
      route?: ContextRemovalRoutePort;
    } = {},
  ) {
    this.desk = dependencies.desk ?? productionDesk;
    this.workingSet = dependencies.workingSet ?? productionWorkingSet;
    this.fallbackRoute = dependencies.route ?? null;
  }

  configureAccount(accountId: string): void {
    if (this.accountId === accountId) return;
    this.accountId = accountId;
    this.resetForHydration();
  }

  resetForHydration(): void {
    for (const [projectId, state] of this.projects) {
      for (const commands of state.deferred.values()) {
        for (const command of commands) command.resolve({ kind: "noop" });
      }
      state.deferred.clear();
      state.rememberedRoute = null;
      state.autoOpenBlock = null;
      if (!this.routePorts.has(projectId)) {
        this.disposeProject(projectId);
        continue;
      }
      const revision = state.selection.revision + 1;
      state.selection =
        state.selection.status === "none"
          ? { status: "none", revision }
          : { status: "pending", revision, locator: state.selection.locator };
      this.publish(state);
    }
  }

  registerRoutePort(
    projectId: string,
    port: ContextRemovalRoutePort,
    activeWorkId: string | null,
  ): { token: symbol; release: () => void } {
    const state = this.project(projectId);
    for (const commands of state.deferred.values()) {
      for (const command of commands) command.resolve({ kind: "noop" });
    }
    state.deferred.clear();
    state.selection = { status: "none", revision: 0 };
    state.autoOpenBlock = null;
    const token = Symbol(projectId);
    this.routePorts.set(projectId, { token, port });
    const recent = recentRouteForEditorWork(
      this.workingSet.readRecentRoutes(projectId),
      activeWorkId,
    );
    state.rememberedRoute = recent
      ? {
          scheme: recent.scheme,
          path: recent.path,
          workId: isWorkScopedProjectContextScheme(recent.scheme)
            ? (recent.workId ?? null)
            : activeWorkId,
        }
      : null;
    this.publish(state);
    return {
      token,
      release: () => {
        if (this.routePorts.get(projectId)?.token !== token) return;
        this.disposeProject(projectId);
      },
    };
  }

  beginRouteSelection(projectId: string, locator: ContextRouteTarget): number {
    const state = this.project(projectId);
    const previous = state.selection;
    const revision = state.selection.revision + 1;
    state.selection = { status: "pending", revision, locator };
    if (previous.status === "pending") {
      this.settleSupersededSelection(projectId, previous, state.selection);
    }
    this.publish(state);
    return revision;
  }

  bindRouteSelection(
    projectId: string,
    revision: number,
    selection: { kind: "server" | "local"; documentId: string },
  ): boolean {
    const state = this.project(projectId);
    if (state.selection.status !== "pending" || state.selection.revision !== revision) return false;
    state.selection = { ...state.selection, status: "bound", selection };
    this.publish(state);
    this.drainDeferred(projectId, revision);
    return true;
  }

  confirmRouteUnbound(projectId: string, revision: number): boolean {
    const state = this.project(projectId);
    if (state.selection.status !== "pending" || state.selection.revision !== revision) return false;
    state.selection = { ...state.selection, status: "confirmed-unbound" };
    this.publish(state);
    this.drainDeferred(projectId, revision);
    return true;
  }

  clearRouteSelection(projectId: string): void {
    const state = this.project(projectId);
    const previous = state.selection;
    const revision = previous.revision + 1;
    state.selection = { status: "none", revision };
    state.autoOpenBlock = null;
    if (previous.status === "pending") {
      this.settleSupersededSelection(projectId, previous, state.selection);
    }
    this.publish(state);
  }

  subscribe(projectId: string, listener: () => void): () => void {
    const state = this.project(projectId);
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  getProjectSnapshot(projectId: string): ContextRemovalProjectSnapshot {
    return this.projects.get(projectId)?.snapshot ?? EMPTY_PROJECT_SNAPSHOT;
  }

  applyDraftMetadata(projectId: string, reviewWorkId: string, documentId: string): void {
    this.desk.resolveDraftApply(projectId, reviewWorkId, documentId);
  }

  writerClose(projectId: string, documentId: string): Promise<ContextRemovalOutcome> {
    return this.executeContextRemoval(projectId, {
      cause: "writer-close",
      documentIds: [documentId],
    });
  }

  acknowledgedDelete(
    projectId: string,
    documentIds: readonly string[],
  ): Promise<ContextRemovalOutcome> {
    return this.executeContextRemoval(projectId, { cause: "acknowledged-delete", documentIds });
  }

  pruneWork(projectId: string, activeWorkId: string): Promise<ContextRemovalOutcome> {
    const documentIds = this.desk
      .read(projectId)
      .tabs.filter(
        (tab): tab is ServerContextTab =>
          tab.kind !== "new" &&
          isWorkScopedProjectContextScheme(tab.scheme) &&
          tab.workId !== activeWorkId,
      )
      .map((tab) => tab.documentId);
    const recent = recentRouteForEditorWork(
      this.workingSet.readRecentRoutes(projectId),
      activeWorkId,
    );
    const state = this.project(projectId);
    state.rememberedRoute = recent
      ? {
          scheme: recent.scheme,
          path: recent.path,
          workId: isWorkScopedProjectContextScheme(recent.scheme)
            ? (recent.workId ?? null)
            : activeWorkId,
        }
      : null;
    this.publish(state);
    return this.executeContextRemoval(projectId, { cause: "work-prune", documentIds });
  }

  discardDraft(
    projectId: string,
    reviewWorkId: string,
    documentId: string,
  ): Promise<ContextRemovalOutcome> {
    const tab = this.desk
      .read(projectId)
      .tabs.find((candidate) => candidate.documentId === documentId);
    return this.executeContextRemoval(projectId, {
      cause: "draft-discard",
      documentIds:
        tab !== undefined &&
        tab.kind !== "new" &&
        tab.draftOnly &&
        tab.reviewWorkId === reviewWorkId
          ? [documentId]
          : [],
    });
  }

  activateRoute(projectId: string, tab: ContextTab, activeWorkId: string | null): void {
    if (tab.draftOnly) return;
    const route = workingSetRouteForTab(tab);
    if (route) {
      this.workingSet.reconcileContextRoutes(projectId, {
        removedLocators: [],
        survivingOwnedLocators: this.desk
          .read(projectId)
          .tabs.flatMap((item) => workingSetRouteForTab(item) ?? []),
        promote: route,
        clearAll: false,
      });
    }
    const state = this.project(projectId);
    state.rememberedRoute = routeTargetForTab(tab, activeWorkId);
    const block = state.autoOpenBlock;
    if (
      !block?.locator ||
      block.locator.scheme !== state.rememberedRoute.scheme ||
      block.locator.path !== state.rememberedRoute.path ||
      block.locator.workId !== state.rememberedRoute.workId ||
      !block.documentIds.includes(tab.documentId)
    ) {
      state.autoOpenBlock = null;
    }
    this.publish(state);
  }

  disposeProject(projectId: string): void {
    const state = this.projects.get(projectId);
    if (state) {
      for (const commands of state.deferred.values()) {
        for (const command of commands) command.resolve({ kind: "noop" });
      }
      state.deferred.clear();
      state.listeners.clear();
      this.projects.delete(projectId);
    }
    this.routePorts.delete(projectId);
  }

  private executeContextRemoval(
    projectId: string,
    intent: ContextRemovalIntent,
  ): Promise<ContextRemovalOutcome> {
    if (intent.documentIds.length === 0) return Promise.resolve({ kind: "noop" });
    const state = this.project(projectId);
    if (
      state.selection.status === "pending" &&
      this.pendingLocatorMayOwnRemoval(projectId, state.selection, intent)
    ) {
      state.autoOpenBlock = {
        selectionRevision: state.selection.revision,
        locator: state.selection.locator,
        documentIds: [...intent.documentIds],
      };
      this.publish(state);
      return new Promise((resolve) => {
        const commands = state.deferred.get(state.selection.revision) ?? [];
        commands.push({ intent, resolve });
        state.deferred.set(state.selection.revision, commands);
      });
    }
    return this.executeNow(projectId, intent, state.selection);
  }

  private async executeNow(
    projectId: string,
    intent: ContextRemovalIntent,
    routeSelection: ContextRouteSelection,
  ): Promise<ContextRemovalOutcome> {
    const slice = this.desk.read(projectId);
    const plan = planContextRemoval({ ...slice, routeSelection, intent });
    if (plan.outcome.kind === "noop") return plan.outcome;

    this.desk.commit(projectId, {
      documentIds: plan.outcome.removed.map((tab) => tab.documentId),
      activeTabId: plan.nextActiveTabId,
    });
    this.workingSet.reconcileContextRoutes(projectId, plan.workingSet);

    const state = this.project(projectId);
    state.rememberedRoute = plan.rememberedRoute;
    const removedOwnsSelection =
      routeSelection.status !== "none" &&
      plan.outcome.removed.some((tab) =>
        tab.kind === "new"
          ? routeSelection.locator.scheme === "scratch" &&
            routeSelection.locator.path === "" &&
            slice.activeTabId === tab.documentId
          : contextTabMatchesRoute(
              tab,
              routeSelection.locator.scheme,
              routeSelection.locator.path,
              routeSelection.locator.workId,
            ),
      );
    state.autoOpenBlock = {
      selectionRevision: routeSelection.revision,
      locator:
        routeSelection.status !== "none" &&
        (plan.outcome.routedDocumentRemoved || removedOwnsSelection)
          ? routeSelection.locator
          : null,
      documentIds: [...intent.documentIds],
    };
    this.publish(state);

    if (
      plan.routeRepairTarget &&
      routeSelection.status === "bound" &&
      this.selectionStillCurrent(projectId, routeSelection)
    ) {
      const route = this.routePorts.get(projectId)?.port ?? this.fallbackRoute;
      const search = route?.readSearch(projectId);
      if (
        route &&
        search?.screen === "context" &&
        search.scheme === routeSelection.locator.scheme &&
        search.path === routeSelection.locator.path &&
        (search.work ?? null) === routeSelection.locator.workId
      ) {
        const repair: ContextRouteRepair = {
          expected: {
            screen: "context",
            work: search.work,
            scheme: routeSelection.locator.scheme,
            path: routeSelection.locator.path,
            selectionRevision: routeSelection.revision,
            selectionDocumentId: routeSelection.selection.documentId,
          },
          next: plan.routeRepairTarget,
        };
        route.updateSearch(projectId, (latest) =>
          this.selectionStillCurrent(projectId, routeSelection)
            ? applyContextRepairIfCurrent(repair, latest)
            : latest,
        );
      }
    }
    return plan.outcome;
  }

  private pendingLocatorMayOwnRemoval(
    projectId: string,
    pending: Extract<ContextRouteSelection, { status: "pending" }>,
    intent: ContextRemovalIntent,
  ): boolean {
    const tabs = this.desk.read(projectId).tabs;
    const representedIds = new Set(tabs.map((tab) => tab.documentId));
    const matchingTab = tabs.some((tab) => {
      if (!contextTabEligibleForRemoval(tab, intent)) return false;
      if (tab.kind === "new") {
        return (
          pending.locator.scheme === "scratch" &&
          pending.locator.path === "" &&
          this.desk.read(projectId).activeTabId === tab.documentId
        );
      }
      return contextTabMatchesRoute(
        tab,
        pending.locator.scheme,
        pending.locator.path,
        pending.locator.workId,
      );
    });
    if (matchingTab) return true;
    // An exact delete receipt can identify a phone-only route with no desktop tab.
    return (
      intent.cause === "acknowledged-delete" &&
      intent.documentIds.some((documentId) => !representedIds.has(documentId))
    );
  }

  private selectionStillCurrent(
    projectId: string,
    expected: Extract<ContextRouteSelection, { status: "bound" }>,
  ): boolean {
    const current = this.project(projectId).selection;
    return (
      current.status === "bound" &&
      current.revision === expected.revision &&
      current.selection.documentId === expected.selection.documentId
    );
  }

  private drainDeferred(projectId: string, revision: number): void {
    const state = this.project(projectId);
    const commands = state.deferred.get(revision);
    if (!commands) return;
    state.deferred.delete(revision);
    for (const command of commands) {
      this.executeNow(projectId, command.intent, state.selection).then(command.resolve);
    }
  }

  private settleSupersededSelection(
    projectId: string,
    pending: Extract<ContextRouteSelection, { status: "pending" }>,
    current: ContextRouteSelection,
  ): void {
    const state = this.project(projectId);
    const commands = state.deferred.get(pending.revision);
    if (!commands) return;
    state.deferred.delete(pending.revision);
    for (const command of commands) {
      const represented = this.desk.read(projectId).tabs.find((tab) => {
        if (!contextTabEligibleForRemoval(tab, command.intent)) return false;
        if (tab.kind === "new") {
          return pending.locator.scheme === "scratch" && pending.locator.path === "";
        }
        return contextTabMatchesRoute(
          tab,
          pending.locator.scheme,
          pending.locator.path,
          pending.locator.workId,
        );
      });
      const documentId =
        represented?.documentId ??
        (command.intent.cause === "acknowledged-delete" && command.intent.documentIds.length === 1
          ? command.intent.documentIds[0]
          : undefined);
      const settledSelection: ContextRouteSelection = documentId
        ? {
            status: "bound",
            revision: pending.revision,
            locator: pending.locator,
            selection: {
              kind: represented?.kind === "new" ? "local" : "server",
              documentId,
            },
          }
        : { ...pending, status: "confirmed-unbound" };
      void this.executeNow(projectId, command.intent, settledSelection).then(command.resolve);
    }
    if (current.status === "pending") {
      const currentRoute = buildWorkingSetRoute(
        current.locator.scheme,
        current.locator.path,
        current.locator.workId,
      );
      if (currentRoute) {
        this.workingSet.reconcileContextRoutes(projectId, {
          removedLocators: [],
          survivingOwnedLocators: [
            ...this.desk.read(projectId).tabs.flatMap((tab) => workingSetRouteForTab(tab) ?? []),
            currentRoute,
          ],
          promote: currentRoute,
          clearAll: false,
        });
      }
      state.rememberedRoute = current.locator;
      state.autoOpenBlock = null;
    }
  }

  private project(projectId: string): CoordinatorProjectState {
    let state = this.projects.get(projectId);
    if (!state) {
      state = {
        selection: { status: "none", revision: 0 },
        rememberedRoute: null,
        autoOpenBlock: null,
        deferred: new Map(),
        listeners: new Set(),
        snapshot: {
          selection: { status: "none", revision: 0 },
          rememberedRoute: null,
          autoOpenBlock: null,
        },
      };
      this.projects.set(projectId, state);
    }
    return state;
  }

  private publish(state: CoordinatorProjectState): void {
    state.snapshot = {
      selection: state.selection,
      rememberedRoute: state.rememberedRoute,
      autoOpenBlock: state.autoOpenBlock,
    };
    for (const listener of state.listeners) listener();
  }
}

export const contextRemovalCoordinator = new ContextRemovalCoordinator();

export function configureContextRemovalAccount(accountId: string): void {
  if (typeof window === "undefined") return;
  contextRemovalCoordinator.configureAccount(accountId);
}

export function resetContextRemovalForHydration(): void {
  if (typeof window === "undefined") return;
  contextRemovalCoordinator.resetForHydration();
}
