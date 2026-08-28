/** Account-lifetime effect shell for exact context removal transitions. */

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
  type ReconcileContextRoutesInput,
  readRecentRoutes,
  recentRouteForEditorWork,
  reconcileContextRoutes,
  workingSetRouteEquals,
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
  type ContextRouteIdentity,
  planContextRemoval,
  type RouteContinuityVerdict,
  routeTargetForTab,
  workingSetRouteForTab,
} from "./context-removal-planner";
import {
  type AcknowledgedContextDeleteCommand,
  type AcknowledgedDeleteAdmission,
  beginSelection,
  bindSelection,
  type CommandAdmissionRecord,
  type ContextDeleteInitiator,
  type ContextRouteSelection,
  confirmSelectionUnbound,
  continuityForSelection,
  type InitiatingRouteWitness,
  leaveSelection,
  type RemovalPlanningEffect,
  reduceAcknowledgedDelete,
  reduceRepresentedRemoval,
  type SelectionTransition,
  sameLocator,
  supersedeSelectionForWorkChange,
  type TerminalRouteRemoval,
} from "./context-removal-protocol";

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

type RemovalFence = {
  selectionRevision: number;
  transitionRevision: number;
  locator: ContextRouteTarget | null;
  removedDocumentIds: readonly string[];
};

export type ContextActivation = {
  projectId: string;
  selectionRevision: number;
  transitionRevision: number;
  locator: ContextRouteTarget;
  identity: ContextRouteIdentity;
};

type CoordinatorProjectState = {
  selection: ContextRouteSelection;
  rememberedRoute: ContextRouteTarget | null;
  removalFence: RemovalFence | null;
  transitionRevision: number;
  terminalRemovals: Map<string, TerminalRouteRemoval>;
  live: boolean;
  listeners: Set<() => void>;
  snapshot: ContextRemovalProjectSnapshot;
};

export type ContextRemovalProjectSnapshot = Pick<
  CoordinatorProjectState,
  "selection" | "rememberedRoute" | "removalFence" | "transitionRevision" | "live"
>;

export type ContextRemovalLifetimeLease = {
  suspend(): void;
  resume(): void;
  disposeIfSuspended(): void;
};

const EMPTY_SLICE: ProjectTabsSlice = { tabs: [], activeTabId: null };
const EMPTY_PROJECT_SNAPSHOT: ContextRemovalProjectSnapshot = {
  selection: { status: "none", revision: 0 },
  rememberedRoute: null,
  removalFence: null,
  transitionRevision: 0,
  live: false,
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

function newCommandId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `delete-${Date.now()}-${Math.random()}`;
}

export class ContextRemovalCoordinator {
  private readonly projects = new Map<string, CoordinatorProjectState>();
  private readonly routePorts = new Map<string, { token: symbol; port: ContextRemovalRoutePort }>();
  private commandAdmissions: ReadonlyMap<string, CommandAdmissionRecord> = new Map();
  private readonly fallbackRoute: ContextRemovalRoutePort | null;
  private readonly desk: DeskPort;
  private readonly workingSet: ContextRemovalWorkingSetPort;
  private disposed = false;
  private suspended = false;

  readonly accountId: string | null;

  constructor(
    accountOrDependencies:
      | string
      | {
          desk?: DeskPort;
          workingSet?: ContextRemovalWorkingSetPort;
          route?: ContextRemovalRoutePort;
        }
      | null = null,
    explicitDependencies: {
      desk?: DeskPort;
      workingSet?: ContextRemovalWorkingSetPort;
      route?: ContextRemovalRoutePort;
    } = {},
  ) {
    const dependencies =
      typeof accountOrDependencies === "object" && accountOrDependencies !== null
        ? accountOrDependencies
        : explicitDependencies;
    this.accountId = typeof accountOrDependencies === "string" ? accountOrDependencies : null;
    this.desk = dependencies.desk ?? productionDesk;
    this.workingSet = dependencies.workingSet ?? productionWorkingSet;
    this.fallbackRoute = dependencies.route ?? null;
  }

  /** A reversible provider lifetime: cleanup revokes now; replay may reacquire before disposal. */
  createLifetimeLease(): ContextRemovalLifetimeLease {
    let held = true;
    return {
      suspend: () => {
        if (!held || this.disposed) return;
        held = false;
        this.suspended = true;
      },
      resume: () => {
        if (held || this.disposed) return;
        held = true;
        this.suspended = false;
      },
      disposeIfSuspended: () => {
        if (!held) this.dispose();
      },
    };
  }

  private unavailable(): boolean {
    return this.disposed || this.suspended;
  }

  activate(activation: ContextActivation): boolean {
    if (this.unavailable()) return false;
    const state = this.project(activation.projectId);
    const selection = state.selection;
    if (
      !state.live ||
      selection.status !== "bound" ||
      selection.revision !== activation.selectionRevision ||
      !sameLocator(selection.locator, activation.locator) ||
      selection.identity.kind !== activation.identity.kind ||
      selection.identity.documentId !== activation.identity.documentId ||
      state.transitionRevision !== activation.transitionRevision
    ) {
      return false;
    }
    const tab = this.desk
      .read(activation.projectId)
      .tabs.find((candidate) => candidate.documentId === activation.identity.documentId);
    if (!tab || tab.draftOnly) return false;
    const tabLocator = routeTargetForTab(tab, activation.locator.workId);
    if (!sameLocator(tabLocator, activation.locator)) return false;
    const fence = state.removalFence;
    if (
      fence?.removedDocumentIds.includes(activation.identity.documentId) &&
      fence.selectionRevision === activation.selectionRevision &&
      fence.locator &&
      sameLocator(fence.locator, activation.locator)
    ) {
      return false;
    }
    if (
      state.removalFence === null &&
      state.rememberedRoute &&
      sameLocator(state.rememberedRoute, activation.locator)
    ) {
      return true;
    }
    const route = workingSetRouteForTab(tab);
    if (route) {
      this.workingSet.reconcileContextRoutes(activation.projectId, {
        removedLocators: [],
        survivingOwnedLocators: this.desk
          .read(activation.projectId)
          .tabs.flatMap((item) => workingSetRouteForTab(item) ?? []),
        promote: route,
        clearAll: false,
      });
    }
    state.rememberedRoute = activation.locator;
    state.removalFence = null;
    this.publish(state);
    return true;
  }

  registerRoutePort(
    projectId: string,
    port: ContextRemovalRoutePort,
    activeWorkId: string | null,
  ): { token: symbol; release: () => void } {
    if (this.unavailable()) return { token: Symbol(projectId), release: () => undefined };
    const state = this.project(projectId);
    const token = Symbol(projectId);
    this.routePorts.set(projectId, { token, port });
    state.live = true;
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
        this.leaveSelection(projectId);
        this.routePorts.delete(projectId);
        state.live = false;
        this.publish(state);
      },
    };
  }

  beginRouteSelection(projectId: string, locator: ContextRouteTarget): number {
    if (this.unavailable()) return this.projects.get(projectId)?.selection.revision ?? 0;
    const state = this.project(projectId);
    const transition = beginSelection(
      state.selection,
      locator,
      state.terminalRemovals.get(locatorKey(locator)) ?? null,
    );
    this.applySelectionTransition(projectId, transition);
    return transition.selection.revision;
  }

  bindRouteSelection(projectId: string, revision: number, identity: ContextRouteIdentity): boolean {
    if (this.unavailable()) return false;
    const transition = bindSelection(this.project(projectId).selection, revision, identity);
    if (!transition) return false;
    this.applySelectionTransition(projectId, transition);
    return true;
  }

  confirmRouteUnbound(projectId: string, revision: number): boolean {
    if (this.unavailable()) return false;
    const transition = confirmSelectionUnbound(this.project(projectId).selection, revision);
    if (!transition) return false;
    this.applySelectionTransition(projectId, transition);
    return true;
  }

  clearRouteSelection(projectId: string): void {
    if (this.unavailable()) return;
    this.leaveSelection(projectId);
  }

  subscribe(projectId: string, listener: () => void): () => void {
    if (this.unavailable()) return () => undefined;
    const state = this.project(projectId);
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  getProjectSnapshot(projectId: string): ContextRemovalProjectSnapshot {
    return this.projects.get(projectId)?.snapshot ?? EMPTY_PROJECT_SNAPSHOT;
  }

  captureDeleteInitiation(
    projectId: string,
    initiated: ContextDeleteInitiator,
  ): Omit<AcknowledgedContextDeleteCommand, "cause" | "confirmed"> {
    const selection = this.projects.get(projectId)?.selection ?? EMPTY_PROJECT_SNAPSHOT.selection;
    let routeWitness: InitiatingRouteWitness = null;
    if (selection.status === "pending" && sameLocator(selection.locator, initiated.locator)) {
      routeWitness = {
        status: "pending",
        revision: selection.revision,
        locator: selection.locator,
      };
    } else if (selection.status === "bound" && sameLocator(selection.locator, initiated.locator)) {
      routeWitness = {
        status: "bound",
        revision: selection.revision,
        locator: selection.locator,
        identity: selection.identity,
      };
    }
    return { commandId: newCommandId(), projectId, initiated, routeWitness };
  }

  acceptAcknowledgedDelete(command: AcknowledgedContextDeleteCommand): AcknowledgedDeleteAdmission {
    if (this.unavailable()) return { status: "rejected", reason: "coordinator_disposed" };
    const state = this.project(command.projectId);
    const transition = reduceAcknowledgedDelete(this.commandAdmissions, state.selection, command);
    this.commandAdmissions = transition.records;
    if (transition.admission.status !== "accepted") return transition.admission;
    state.selection = transition.selection;
    if (transition.planning) this.executePlanning(command.projectId, transition.planning);
    this.publish(state);
    return transition.admission;
  }

  applyDraftMetadata(projectId: string, reviewWorkId: string, documentId: string): void {
    if (this.unavailable()) return;
    this.desk.resolveDraftApply(projectId, reviewWorkId, documentId);
  }

  writerClose(projectId: string, documentId: string): ContextRemovalOutcome {
    if (this.unavailable()) return { kind: "noop" };
    return this.executeRepresented(projectId, {
      cause: "writer-close",
      documentIds: [documentId],
    });
  }

  pruneWork(projectId: string, activeWorkId: string): ContextRemovalOutcome {
    if (this.unavailable()) return { kind: "noop" };
    const state = this.project(projectId);
    const { documentIds, obsoleteRoutes } = this.readWorkPruneEvidence(
      projectId,
      activeWorkId,
      state.selection,
    );
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
    const outcome = this.executeRepresented(
      projectId,
      { cause: "work-prune", documentIds },
      obsoleteRoutes,
    );
    this.publish(state);
    return outcome;
  }

  /** Owns the synchronous old-Work prune and next-Work route transition. */
  changeWorkSelection(
    projectId: string,
    activeWorkId: string,
    locator: ContextRouteTarget | null,
  ): number | null {
    if (this.unavailable()) return null;
    const state = this.project(projectId);
    const previousSelection = state.selection;
    const tabs = this.desk.read(projectId).tabs;
    const { documentIds, obsoleteRoutes } = this.readWorkPruneEvidence(
      projectId,
      activeWorkId,
      previousSelection,
    );
    const transition = supersedeSelectionForWorkChange(
      previousSelection,
      locator,
      locator ? (state.terminalRemovals.get(locatorKey(locator)) ?? null) : null,
    );
    const current = continuityForSelection(transition.selection);
    state.selection = transition.selection;
    state.rememberedRoute = locator;

    if (documentIds.length > 0) {
      const represented = reduceRepresentedRemoval(
        previousSelection,
        tabs,
        { cause: "work-prune", documentIds },
        newCommandId(),
      );
      this.executePlanning(
        projectId,
        { ...represented.planning, current, repair: "never" },
        obsoleteRoutes,
      );
    } else {
      const nextRoute = locator ? workingSetRouteForTarget(locator) : null;
      this.workingSet.reconcileContextRoutes(projectId, {
        removedLocators: obsoleteRoutes,
        survivingOwnedLocators: [
          ...tabs.flatMap((tab) => workingSetRouteForTab(tab) ?? []),
          ...(nextRoute ? [nextRoute] : []),
        ].filter(
          (route) => !obsoleteRoutes.some((removed) => workingSetRouteEquals(route, removed)),
        ),
        promote: nextRoute,
        clearAll: false,
      });
      state.rememberedRoute = locator;
    }
    for (const planning of transition.planning) this.executePlanning(projectId, planning);
    this.publish(state);
    return transition.selection.status === "none" ? null : transition.selection.revision;
  }

  discardDraft(projectId: string, reviewWorkId: string, documentId: string): ContextRemovalOutcome {
    if (this.unavailable()) return { kind: "noop" };
    const tab = this.desk
      .read(projectId)
      .tabs.find((candidate) => candidate.documentId === documentId);
    return this.executeRepresented(projectId, {
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const projectId of [...this.projects.keys()]) this.disposeProject(projectId);
    this.commandAdmissions = new Map();
  }

  disposeProject(projectId: string): void {
    const state = this.projects.get(projectId);
    state?.listeners.clear();
    this.projects.delete(projectId);
    this.routePorts.delete(projectId);
  }

  private executeRepresented(
    projectId: string,
    intent: ContextRemovalIntent,
    additionalRemovedLocators: readonly WorkingSetRoute[] = [],
  ): ContextRemovalOutcome {
    const state = this.project(projectId);
    if (intent.documentIds.length === 0) {
      if (additionalRemovedLocators.length > 0) {
        this.workingSet.reconcileContextRoutes(projectId, {
          removedLocators: additionalRemovedLocators,
          survivingOwnedLocators: this.desk
            .read(projectId)
            .tabs.flatMap((tab) => workingSetRouteForTab(tab) ?? []),
          promote: null,
          clearAll: false,
        });
      }
      return { kind: "noop" };
    }
    const transition = reduceRepresentedRemoval(
      state.selection,
      this.desk.read(projectId).tabs,
      intent,
      newCommandId(),
    );
    state.selection = transition.selection;
    const outcome = this.executePlanning(projectId, transition.planning, additionalRemovedLocators);
    this.publish(state);
    return outcome;
  }

  private readWorkPruneEvidence(
    projectId: string,
    activeWorkId: string,
    selection: ContextRouteSelection,
  ): { documentIds: string[]; obsoleteRoutes: WorkingSetRoute[] } {
    const documentIds = this.desk
      .read(projectId)
      .tabs.filter(
        (tab): tab is ServerContextTab =>
          tab.kind !== "new" &&
          isWorkScopedProjectContextScheme(tab.scheme) &&
          tab.workId !== activeWorkId,
      )
      .map((tab) => tab.documentId);
    if (
      selection.status === "bound" &&
      isWorkScopedProjectContextScheme(selection.locator.scheme) &&
      selection.locator.workId !== activeWorkId &&
      !documentIds.includes(selection.identity.documentId)
    ) {
      documentIds.push(selection.identity.documentId);
    }
    return {
      documentIds,
      obsoleteRoutes: this.workingSet
        .readRecentRoutes(projectId)
        .filter(
          (route) =>
            isWorkScopedProjectContextScheme(route.scheme) && route.workId !== activeWorkId,
        ),
    };
  }

  private executePlanning(
    projectId: string,
    effect: RemovalPlanningEffect,
    additionalRemovedLocators: readonly WorkingSetRoute[] = [],
  ): ContextRemovalOutcome {
    const { intent, current, cleanup, repair } = effect;
    if (intent.documentIds.length === 0) return { kind: "noop" };
    const slice = this.desk.read(projectId);
    const plan = planContextRemoval({
      ...slice,
      rememberedRoute: this.project(projectId).rememberedRoute,
      route: { cleanup, current },
      intent,
    });
    if (plan.outcome.kind === "noop") {
      if (additionalRemovedLocators.length > 0) {
        this.workingSet.reconcileContextRoutes(projectId, {
          removedLocators: additionalRemovedLocators,
          survivingOwnedLocators: plan.workingSet.survivingOwnedLocators.filter(
            (route) =>
              !additionalRemovedLocators.some((removed) => workingSetRouteEquals(route, removed)),
          ),
          promote:
            plan.workingSet.promote &&
            additionalRemovedLocators.some((removed) =>
              workingSetRouteEquals(plan.workingSet.promote as WorkingSetRoute, removed),
            )
              ? null
              : plan.workingSet.promote,
          clearAll: false,
        });
      }
      return plan.outcome;
    }

    this.desk.commit(projectId, {
      documentIds: plan.outcome.removed.map((tab) => tab.documentId),
      activeTabId: plan.nextActiveTabId,
    });
    this.workingSet.reconcileContextRoutes(projectId, {
      ...plan.workingSet,
      removedLocators: [...plan.workingSet.removedLocators, ...additionalRemovedLocators],
      survivingOwnedLocators: plan.workingSet.survivingOwnedLocators.filter(
        (route) =>
          !additionalRemovedLocators.some((removed) => workingSetRouteEquals(route, removed)),
      ),
      promote:
        plan.workingSet.promote &&
        additionalRemovedLocators.some((removed) =>
          workingSetRouteEquals(plan.workingSet.promote as WorkingSetRoute, removed),
        )
          ? null
          : plan.workingSet.promote,
    });

    const state = this.project(projectId);
    state.transitionRevision += 1;
    state.rememberedRoute = plan.rememberedRoute;
    state.removalFence = {
      selectionRevision: current.kind === "none" ? state.selection.revision : current.revision,
      transitionRevision: state.transitionRevision,
      locator:
        current.kind === "none" || !plan.outcome.routedDocumentRemoved ? null : current.locator,
      removedDocumentIds: [...intent.documentIds],
    };
    if (cleanup && (intent.cause === "acknowledged-delete" || intent.cause === "draft-discard")) {
      state.terminalRemovals.set(locatorKey(cleanup.locator), { cleanup, intent });
    }
    this.publish(state);

    if (repair === "allow" && plan.routeRepairTarget && current.kind === "proven-removed") {
      const route = this.routePorts.get(projectId)?.port ?? this.fallbackRoute;
      const search = route?.readSearch(projectId);
      if (
        route &&
        search?.screen === "context" &&
        search.scheme === current.locator.scheme &&
        search.path === current.locator.path &&
        (search.work ?? null) === current.locator.workId
      ) {
        const repairPlan: ContextRouteRepair = {
          expected: {
            screen: "context",
            work: search.work,
            scheme: current.locator.scheme,
            path: current.locator.path,
            selectionRevision: current.revision,
            selectionDocumentId: current.identity.documentId,
          },
          next: plan.routeRepairTarget,
        };
        route.updateSearch(projectId, (latest) =>
          this.removalStillCurrent(projectId, current)
            ? applyContextRepairIfCurrent(repairPlan, latest)
            : latest,
        );
      }
    }
    return plan.outcome;
  }

  private removalStillCurrent(
    projectId: string,
    removal: Extract<RouteContinuityVerdict, { kind: "proven-removed" }>,
  ): boolean {
    const selection = this.project(projectId).selection;
    if (
      selection.status === "none" ||
      selection.revision !== removal.revision ||
      !sameLocator(selection.locator, removal.locator)
    ) {
      return false;
    }
    return (
      selection.status === "confirmed-unbound" ||
      (selection.status === "bound" &&
        selection.identity.kind === removal.identity.kind &&
        selection.identity.documentId === removal.identity.documentId)
    );
  }

  private applySelectionTransition(projectId: string, transition: SelectionTransition): void {
    const state = this.project(projectId);
    state.selection = transition.selection;
    if (transition.retireReentryGuard && transition.selection.status !== "none") {
      state.terminalRemovals.delete(locatorKey(transition.selection.locator));
    }
    for (const continuity of transition.promote) {
      if (continuity.kind !== "none") this.promoteUnknown(projectId, continuity.locator);
    }
    for (const planning of transition.planning) this.executePlanning(projectId, planning);
    this.publish(state);
  }

  private promoteUnknown(projectId: string, locator: ContextRouteTarget): void {
    const route = workingSetRouteForTarget(locator);
    if (route) {
      this.workingSet.reconcileContextRoutes(projectId, {
        removedLocators: [],
        survivingOwnedLocators: [
          ...this.desk.read(projectId).tabs.flatMap((tab) => workingSetRouteForTab(tab) ?? []),
          route,
        ],
        promote: route,
        clearAll: false,
      });
    }
    const state = this.project(projectId);
    state.rememberedRoute = locator;
    this.publish(state);
  }

  private leaveSelection(projectId: string): void {
    const state = this.projects.get(projectId);
    if (!state) return;
    this.applySelectionTransition(projectId, leaveSelection(state.selection));
    this.publish(state);
  }

  private project(projectId: string): CoordinatorProjectState {
    let state = this.projects.get(projectId);
    if (!state) {
      state = {
        selection: { status: "none", revision: 0 },
        rememberedRoute: null,
        removalFence: null,
        transitionRevision: 0,
        terminalRemovals: new Map(),
        live: false,
        listeners: new Set(),
        snapshot: EMPTY_PROJECT_SNAPSHOT,
      };
      this.projects.set(projectId, state);
    }
    return state;
  }

  private publish(state: CoordinatorProjectState): void {
    state.snapshot = {
      selection: state.selection,
      rememberedRoute: state.rememberedRoute,
      removalFence: state.removalFence,
      transitionRevision: state.transitionRevision,
      live: state.live,
    };
    for (const listener of state.listeners) listener();
  }
}

function workingSetRouteForTarget(locator: ContextRouteTarget): WorkingSetRoute | null {
  if (locator.scheme === "scratch" || locator.scheme === "uploads") {
    return locator.workId
      ? { scheme: locator.scheme, path: locator.path, workId: locator.workId }
      : null;
  }
  return { scheme: locator.scheme, path: locator.path };
}

function locatorKey(locator: ContextRouteTarget): string {
  return `${locator.scheme}\u0000${locator.path}\u0000${locator.workId ?? ""}`;
}
