/** Account-lifetime effect shell for exact context removal transitions. */

import {
  isWorkScopedProjectContextScheme,
  type LiveDocumentSessionAuthority,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";
import {
  type ContextTab,
  commitContextAvailability,
  commitDraftApplyMetadata,
  commitPlannedContextRemoval,
  commitReviewOverlayClose,
  type DraftDeskSettlementReceipt,
  getContextTabs,
  type ProjectTabsSlice,
  type ReviewOverlayConsumeReceipt,
  type ReviewOverlayTabIdentity,
  type ServerContextTab,
} from "@/client/stores";
import {
  type ReconcileContextRoutesInput,
  readRecentRoutes,
  reconcileContextRoutes,
  replaceRecentRoutes,
  workingSetRouteEquals,
} from "@/client/working-set";
import {
  applyContextRepairIfCurrent,
  type ContextRouteRepair,
  type ContextRouteTarget,
  contextRouteMatchesSearch,
  type ProjectSearch,
  projectSearchEquals,
} from "../routing/project-route";
import {
  type ContextAvailabilityLocalBatchPlan,
  planContextAvailabilityBatch,
} from "./context-availability-effect-planner";
import {
  type ContextRemovalIntent,
  type ContextRemovalOutcome,
  type ContextRouteIdentity,
  chooseAdmittedFallback,
  planCandidateRejection,
  planContextRemoval,
  type RouteContinuityVerdict,
  routeTargetForTab,
  workingSetRouteForTab,
  workingSetRouteForTarget,
} from "./context-removal-planner";
import {
  beginSelection,
  bindSelection,
  type ContextRouteSelection,
  leaveSelection,
  type RemovalPlanningEffect,
  reduceRepresentedRemoval,
  rejectSelection,
  type SelectionTransition,
  sameLocator,
  supersedeSelectionForWorkChange,
  type TerminalRouteRemoval,
} from "./context-removal-protocol";
import type { ProjectDocumentAvailabilityCommand } from "./project-context-availability-coordinator";

type ContextRemovalWorkingSetPort = {
  readRecentRoutes(projectId: string): WorkingSetRoute[];
  reconcileContextRoutes(projectId: string, input: ReconcileContextRoutesInput): WorkingSetRoute[];
  replaceRecentRoutes(projectId: string, routes: readonly WorkingSetRoute[]): WorkingSetRoute[];
};

export interface DraftTabMutationFencePort {
  currentFence(input: {
    accountId: string;
    projectId: string;
    workId: string;
    documentId: string;
    draftId: string;
    tabInstanceToken: string;
  }): "unfenced" | "apply-reservation-pending";
}

export type ContextRemovalRoutePort = {
  readSearch(projectId: string): ProjectSearch;
  updateSearch(projectId: string, update: (latest: ProjectSearch) => ProjectSearch): void;
};

type DeskPort = {
  read(projectId: string): ProjectTabsSlice;
  commit(
    projectId: string,
    input: {
      documentIds: readonly string[];
      deskSelection?: { workId: string; documentId: string | null };
    },
  ): ContextTab[];
  settleDraft(
    projectId: string,
    identity: ReviewOverlayTabIdentity,
    disposition?: "applied" | "discarded",
  ): Promise<DraftDeskSettlementReceipt>;
  closeReviewTab(
    projectId: string,
    identity: ReviewOverlayTabIdentity,
  ): ReviewOverlayConsumeReceipt;
  applyAvailability(
    projectId: string,
    prior: ProjectTabsSlice,
    next: ProjectTabsSlice,
  ): Promise<void> | void;
};

type RemovalFence = {
  selectionRevision: number;
  transitionRevision: number;
  locator: ContextRouteTarget | null;
  removedDocumentIds: readonly string[];
};

export type ContextRouteActivation = {
  projectId: string;
  selectionRevision: number;
  transitionRevision: number;
  locator: ContextRouteTarget;
  identity: ContextRouteIdentity;
  owner: { kind: "desk"; documentId: string } | { kind: "route-only" };
};

type CoordinatorProjectState = {
  activeWorkId: string | null;
  selection: ContextRouteSelection;
  admitted: ContextRouteTarget | null;
  removalFence: RemovalFence | null;
  transitionRevision: number;
  terminalRemovals: Map<string, TerminalRouteRemoval>;
  live: boolean;
  listeners: Set<() => void>;
  snapshot: ContextRemovalProjectSnapshot;
};

export type ContextRemovalProjectSnapshot = Pick<
  CoordinatorProjectState,
  "activeWorkId" | "selection" | "admitted" | "removalFence" | "transitionRevision" | "live"
>;

export type AppliedAvailabilityCommand = Readonly<{
  generation: string;
  commandId: string;
  kind: ProjectDocumentAvailabilityCommand["kind"];
}>;

export type ContextAvailabilitySessionEffectResult =
  | Readonly<{
      commandId: string;
      operation: "revoke-document" | "revoke-access";
      status: "fulfilled";
    }>
  | Readonly<{
      commandId: string;
      operation: "revoke-document" | "revoke-access";
      status: "rejected";
      reason: unknown;
    }>;

export type ContextAvailabilityEffectReceipt = Readonly<{
  committedCommandIds: readonly string[];
  replayedCommandIds: readonly string[];
  staleCommandIds: readonly string[];
  localSettlement: Promise<void>;
  sessionSettlement: Promise<readonly ContextAvailabilitySessionEffectResult[]>;
}>;

type PendingSessionAvailabilityEffect = ContextAvailabilityLocalBatchPlan["sessionEffects"][number];

export type ContextRemovalLifetimeLease = {
  suspend(): void;
  resume(): void;
  disposeIfSuspended(): boolean;
};

export type DraftRecoveryContextCommand = Readonly<{
  identity: {
    accountId: string;
    projectId: string;
    workId: string;
    documentId: string;
    draftId: string;
  };
  entryVersion: number;
  dispositionToken: number;
  disposition: "live-ready" | "writer-abandoned";
  draftTab:
    | { kind: "none" }
    | {
        kind: "draft-only";
        reviewWorkId: string;
        reviewDraftId: string;
        tabInstanceToken: string;
      };
}>;

export type DraftRecoveryContextReceipt = Readonly<{
  kind:
    | "metadata-resolved"
    | "tab-removed"
    | "already-absent"
    | "obsolete-obligation"
    | "not-applicable"
    | "stale-obligation";
  recovery: {
    identity: DraftRecoveryContextCommand["identity"];
    entryVersion: number;
  };
  dispositionToken: number;
}>;

const EMPTY_PROJECT_SNAPSHOT: ContextRemovalProjectSnapshot = {
  activeWorkId: null,
  selection: { status: "none", revision: 0 },
  admitted: null,
  removalFence: null,
  transitionRevision: 0,
  live: false,
};

const productionDesk: DeskPort = {
  read: getContextTabs,
  commit: commitPlannedContextRemoval,
  settleDraft: commitDraftApplyMetadata,
  closeReviewTab: commitReviewOverlayClose,
  applyAvailability: commitContextAvailability,
};

const productionWorkingSet: ContextRemovalWorkingSetPort = {
  readRecentRoutes,
  reconcileContextRoutes,
  replaceRecentRoutes,
};

export class ContextRemovalCoordinator {
  private readonly projects = new Map<string, CoordinatorProjectState>();
  private readonly routePorts = new Map<string, { token: symbol; port: ContextRemovalRoutePort }>();
  private readonly fallbackRoute: ContextRemovalRoutePort | null;
  private readonly desk: DeskPort;
  private readonly workingSet: ContextRemovalWorkingSetPort;
  private readonly sessions: LiveDocumentSessionAuthority | null;
  private readonly draftTabFence: DraftTabMutationFencePort | null;
  private readonly appliedAvailability = new Map<string, AppliedAvailabilityCommand>();
  private readonly pendingSessionEffects = new Map<string, PendingSessionAvailabilityEffect>();
  private readonly sessionEffectRuns = new Map<
    string,
    Promise<ContextAvailabilitySessionEffectResult>
  >();
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
          sessions?: LiveDocumentSessionAuthority;
          draftTabFence?: DraftTabMutationFencePort;
        }
      | null = null,
    explicitDependencies: {
      desk?: DeskPort;
      workingSet?: ContextRemovalWorkingSetPort;
      route?: ContextRemovalRoutePort;
      sessions?: LiveDocumentSessionAuthority;
      draftTabFence?: DraftTabMutationFencePort;
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
    this.sessions = dependencies.sessions ?? null;
    this.draftTabFence = dependencies.draftTabFence ?? null;
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
        if (held) return false;
        this.dispose();
        return true;
      },
    };
  }

  private unavailable(): boolean {
    return this.disposed || this.suspended;
  }

  activate(activation: ContextRouteActivation): boolean {
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
    const tabs = this.desk.read(activation.projectId).tabs;
    const owner = activation.owner;
    const tab =
      owner.kind === "desk"
        ? tabs.find((candidate) => candidate.documentId === owner.documentId)
        : null;
    if (owner.kind === "desk") {
      if (!tab || tab.documentId !== activation.identity.documentId || tab.draftOnly) return false;
      if (!sameLocator(routeTargetForTab(tab, activation.locator.workId), activation.locator)) {
        return false;
      }
    } else {
      const route = this.routePorts.get(activation.projectId)?.port ?? this.fallbackRoute;
      const search = route?.readSearch(activation.projectId);
      if (
        activation.identity.kind !== "server" ||
        !contextRouteMatchesSearch(search, activation.locator, state.activeWorkId)
      ) {
        return false;
      }
    }
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
      state.admitted &&
      sameLocator(state.admitted, activation.locator)
    ) {
      return true;
    }
    const route = tab
      ? workingSetRouteForTab(tab)
      : workingSetRouteForTarget(activation.identity.documentId, activation.locator);
    if (route) {
      this.workingSet.reconcileContextRoutes(activation.projectId, {
        removedLocators: [],
        survivingOwnedLocators: [
          ...tabs.flatMap((item) => workingSetRouteForTab(item) ?? []),
          ...(owner.kind === "route-only" ? [route] : []),
        ],
        promote: route,
        clearAll: false,
      });
    }
    state.admitted = activation.locator;
    state.removalFence = null;
    this.publish(state);
    return true;
  }

  /** Guarded route repair for a selected local Untitled whose server locator arrived. */
  redirectMaterializedLocal(
    projectId: string,
    selectionRevision: number,
    documentId: string,
    target: ContextRouteTarget,
  ): boolean {
    if (this.unavailable()) return false;
    const state = this.project(projectId);
    const selection = state.selection;
    const workId = state.activeWorkId;
    const tab = this.desk
      .read(projectId)
      .tabs.find((candidate) => candidate.documentId === documentId);
    if (
      !state.live ||
      !workId ||
      selection.status === "none" ||
      selection.revision !== selectionRevision ||
      selection.locator.scheme !== "scratch" ||
      selection.locator.path !== "" ||
      selection.locator.workId !== workId ||
      this.desk.read(projectId).selectedTabIdByWork[workId] !== documentId ||
      tab?.kind !== "tracked" ||
      tab.origin !== "local-untitled" ||
      (isWorkScopedProjectContextScheme(tab.scheme) && tab.workId !== workId) ||
      !sameLocator(routeTargetForTab(tab, workId), target)
    ) {
      return false;
    }
    const route = this.routePorts.get(projectId)?.port ?? this.fallbackRoute;
    const search = route?.readSearch(projectId);
    if (!route || search?.screen !== "context") return false;
    const repair: ContextRouteRepair = {
      expectedSearch: {
        screen: "context",
        work: search.work,
        scheme: "scratch",
        path: "",
      },
      expectedSelection: { kind: "materialized-local", revision: selectionRevision, documentId },
      next: target,
    };
    route.updateSearch(projectId, (latest) => {
      const current = this.project(projectId);
      return current.selection.status !== "none" &&
        current.selection.revision === selectionRevision &&
        this.desk.read(projectId).selectedTabIdByWork[workId] === documentId
        ? applyContextRepairIfCurrent(repair, latest)
        : latest;
    });
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
    if (state.activeWorkId !== activeWorkId) {
      this.changeWorkSelection(projectId, activeWorkId, null);
    }
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

  rejectRouteCandidate(
    projectId: string,
    revision: number,
    reason: "fulfilled-absence" | "missing-local-owner" = "fulfilled-absence",
  ): boolean {
    if (this.unavailable()) return false;
    const transition = rejectSelection(this.project(projectId).selection, revision, reason);
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

  async settleDraftRecovery(
    command: DraftRecoveryContextCommand,
  ): Promise<DraftRecoveryContextReceipt> {
    const receipt = (kind: DraftRecoveryContextReceipt["kind"]): DraftRecoveryContextReceipt => ({
      kind,
      recovery: { identity: command.identity, entryVersion: command.entryVersion },
      dispositionToken: command.dispositionToken,
    });
    if (this.unavailable() || command.identity.accountId !== this.accountId)
      return receipt("stale-obligation");
    if (command.draftTab.kind === "none") return receipt("not-applicable");
    const draftTab = command.draftTab;
    const tabs = this.desk.read(command.identity.projectId).tabs;
    const exact = tabs.find(
      (tab) =>
        tab.documentId === command.identity.documentId &&
        tab.kind !== "new" &&
        tab.draftOnly &&
        tab.reviewWorkId === draftTab.reviewWorkId &&
        tab.reviewDraftId === draftTab.reviewDraftId &&
        tab.tabInstanceToken === draftTab.tabInstanceToken,
    );
    if (!exact) {
      const oldToken = tabs.find(
        (tab) => tab.kind !== "new" && tab.tabInstanceToken === draftTab.tabInstanceToken,
      );
      if (oldToken) return receipt("stale-obligation");
      const replacement = tabs.find((tab) => tab.documentId === command.identity.documentId);
      return receipt(replacement ? "obsolete-obligation" : "already-absent");
    }
    if (command.disposition === "live-ready") {
      if (!exact.tabInstanceId) return receipt("stale-obligation");
      const identity = {
        documentId: exact.documentId,
        tabInstanceId: exact.tabInstanceId,
        reviewWorkId: draftTab.reviewWorkId,
        reviewDraftId: draftTab.reviewDraftId,
        tabInstanceToken: draftTab.tabInstanceToken,
      };
      const settled = await this.desk.settleDraft(command.identity.projectId, identity);
      if (settled.kind !== "settled") return receipt("stale-obligation");
      const consumed = this.desk.closeReviewTab(command.identity.projectId, identity);
      return receipt(consumed.kind === "consumed" ? "metadata-resolved" : "stale-obligation");
    }
    if (!exact.tabInstanceId) return receipt("stale-obligation");
    const identity = {
      documentId: exact.documentId,
      tabInstanceId: exact.tabInstanceId,
      reviewWorkId: draftTab.reviewWorkId,
      reviewDraftId: draftTab.reviewDraftId,
      tabInstanceToken: draftTab.tabInstanceToken,
    };
    const settled = await this.desk.settleDraft(command.identity.projectId, identity, "discarded");
    if (settled.kind !== "settled") return receipt("stale-obligation");
    const consumed = this.desk.closeReviewTab(command.identity.projectId, identity);
    return receipt(consumed.kind === "consumed" ? "tab-removed" : "stale-obligation");
  }

  /** One logical project-final batch across desk, route, recent-route, selection, and sessions. */
  reconcileDocumentAvailability(
    commands: readonly ProjectDocumentAvailabilityCommand[],
  ): ContextAvailabilityEffectReceipt {
    if (this.unavailable()) return this.emptyAvailabilityReceipt();
    const normalized = this.normalizeAvailabilityCommands(commands);
    if (normalized.length === 0) return this.emptyAvailabilityReceipt();

    const committed: ProjectDocumentAvailabilityCommand[] = [];
    const replayed: ProjectDocumentAvailabilityCommand[] = [];
    const staleCommandIds: string[] = [];
    for (const command of normalized) {
      const id = availabilityDocumentId(command);
      const key = `${command.projectId}/${id}`;
      const previous = this.appliedAvailability.get(key);
      if (!previous) {
        committed.push(command);
        continue;
      }
      const comparison = BigInt(command.generation) - BigInt(previous.generation);
      if (comparison < 0n) {
        staleCommandIds.push(command.commandId);
      } else if (comparison === 0n) {
        if (previous.commandId !== command.commandId || previous.kind !== command.kind) {
          throw new Error(`Availability command collision for ${key}`);
        }
        replayed.push(command);
      } else {
        committed.push(command);
      }
    }

    const projectId = normalized[0]?.projectId as string;
    const state = this.project(projectId);
    let plan: ContextAvailabilityLocalBatchPlan | null = null;
    if (committed.length > 0) {
      const route = this.routePorts.get(projectId)?.port ?? this.fallbackRoute;
      const routeSearch = route?.readSearch(projectId) ?? null;
      const priorDesk = this.desk.read(projectId);
      plan = planContextAvailabilityBatch({
        commands: committed,
        project: state.snapshot,
        tabs: priorDesk,
        recentRoutes: this.workingSet.readRecentRoutes(projectId),
        routeSearch,
        appliedGenerations: this.appliedAvailability,
      });

      const deskSettlement = this.desk.applyAvailability(projectId, priorDesk, {
        tabs: [...plan.tabs],
        selectedTabIdByWork: { ...plan.selectedTabIdByWork },
      });
      const settledPlan = plan;
      const settleLocal = () => {
        this.workingSet.replaceRecentRoutes(projectId, settledPlan.recentRoutes);
        state.selection = settledPlan.selection;
        state.admitted = settledPlan.admitted;
        state.removalFence = settledPlan.removalFence;
        state.transitionRevision = settledPlan.transitionRevision;
        for (const record of settledPlan.generationRecords) {
          this.appliedAvailability.set(`${projectId}/${record.documentId}`, {
            generation: record.generation,
            commandId: record.commandId,
            kind: record.kind,
          });
        }
        if (route && routeSearch && settledPlan.routeSearch) {
          const nextRouteSearch = settledPlan.routeSearch;
          route.updateSearch(projectId, (latest) =>
            projectSearchEquals(latest, routeSearch) ? nextRouteSearch : latest,
          );
        }
        this.publish(state);
        return settledPlan.sessionEffects;
      };

      const replayEffects = replayed.flatMap((command) => availabilitySessionEffect(command));
      const settleEffects = (plannedEffects: typeof settledPlan.sessionEffects) => {
        const effects = [...plannedEffects, ...replayEffects].map((effect) => {
          const pending = this.pendingSessionEffects.get(effect.commandId);
          if (pending) return pending;
          this.pendingSessionEffects.set(effect.commandId, effect);
          return effect;
        });
        return Promise.all(effects.map((effect) => this.startSessionEffect(effect)));
      };
      if (!deskSettlement) {
        const sessionSettlement = settleEffects(settleLocal());
        return {
          committedCommandIds: committed.map((command) => command.commandId),
          replayedCommandIds: replayed.map((command) => command.commandId),
          staleCommandIds,
          localSettlement: Promise.resolve(),
          sessionSettlement,
        };
      }
      const plannedEffects = deskSettlement.then(settleLocal);
      return {
        committedCommandIds: committed.map((command) => command.commandId),
        replayedCommandIds: replayed.map((command) => command.commandId),
        staleCommandIds,
        localSettlement: plannedEffects.then(() => undefined),
        sessionSettlement: plannedEffects.then(settleEffects, () => []),
      };
    }

    const replayEffects = replayed.flatMap((command) => availabilitySessionEffect(command));
    const effects = replayEffects.map((effect) => {
      const pending = this.pendingSessionEffects.get(effect.commandId);
      if (pending) return pending;
      this.pendingSessionEffects.set(effect.commandId, effect);
      return effect;
    });
    const runs = effects.map((effect) => this.startSessionEffect(effect));
    return {
      committedCommandIds: committed.map((command) => command.commandId),
      replayedCommandIds: replayed.map((command) => command.commandId),
      staleCommandIds,
      localSettlement: Promise.resolve(),
      sessionSettlement: Promise.all(runs),
    };
  }

  retryPendingSessionEffects(): Promise<readonly ContextAvailabilitySessionEffectResult[]> {
    const effects = [...this.pendingSessionEffects.values()].sort((left, right) =>
      left.commandId.localeCompare(right.commandId),
    );
    return Promise.all(effects.map((effect) => this.startSessionEffect(effect)));
  }

  private normalizeAvailabilityCommands(
    commands: readonly ProjectDocumentAvailabilityCommand[],
  ): ProjectDocumentAvailabilityCommand[] {
    const projectId = commands[0]?.projectId;
    const byDocument = new Map<string, ProjectDocumentAvailabilityCommand>();
    for (const command of commands) {
      if (command.projectId !== projectId) throw new Error("Availability batch mixes projects");
      const id = availabilityDocumentId(command);
      const previous = byDocument.get(id);
      if (!previous) {
        byDocument.set(id, command);
      } else if (JSON.stringify(previous) !== JSON.stringify(command)) {
        throw new Error(`Availability batch conflicts for document ${id}`);
      }
    }
    return [...byDocument.values()].sort((left, right) =>
      left.commandId.localeCompare(right.commandId),
    );
  }

  private startSessionEffect(
    effect: PendingSessionAvailabilityEffect,
  ): Promise<ContextAvailabilitySessionEffectResult> {
    const existing = this.sessionEffectRuns.get(effect.commandId);
    if (existing) return existing;
    let operation: Promise<unknown>;
    try {
      operation =
        effect.operation === "revoke-document"
          ? (this.sessions?.revokeDocument(
              effect.projectId,
              effect.documentId,
              effect.generation,
              effect.commandId,
            ) ?? Promise.resolve())
          : (this.sessions?.revokeAccess(
              effect.projectId,
              effect.documentId,
              effect.generation,
              effect.commandId,
            ) ?? Promise.resolve());
    } catch (reason) {
      operation = Promise.reject(reason);
    }
    const run = operation.then(
      (): ContextAvailabilitySessionEffectResult => {
        if (this.pendingSessionEffects.get(effect.commandId) === effect) {
          this.pendingSessionEffects.delete(effect.commandId);
        }
        return { commandId: effect.commandId, operation: effect.operation, status: "fulfilled" };
      },
      (reason: unknown): ContextAvailabilitySessionEffectResult => ({
        commandId: effect.commandId,
        operation: effect.operation,
        status: "rejected",
        reason,
      }),
    );
    this.sessionEffectRuns.set(effect.commandId, run);
    void run.finally(() => {
      if (this.sessionEffectRuns.get(effect.commandId) === run) {
        this.sessionEffectRuns.delete(effect.commandId);
      }
    });
    return run;
  }

  private emptyAvailabilityReceipt(): ContextAvailabilityEffectReceipt {
    return {
      committedCommandIds: [],
      replayedCommandIds: [],
      staleCommandIds: [],
      localSettlement: Promise.resolve(),
      sessionSettlement: Promise.resolve([]),
    };
  }

  writerClose(
    projectId: string,
    documentId: string,
  ): ContextRemovalOutcome | { kind: "apply-disposition-pending" } {
    if (this.unavailable()) return { kind: "noop" };
    const slice = this.desk.read(projectId);
    const tab = slice.tabs.find((candidate) => candidate.documentId === documentId);
    if (tab?.kind !== "new" && tab?.draftOnly) {
      if (!tab.tabInstanceId || !tab.reviewWorkId || !tab.reviewDraftId || !tab.tabInstanceToken)
        return { kind: "noop" };
      if (
        this.accountId &&
        this.draftTabFence?.currentFence({
          accountId: this.accountId,
          projectId,
          workId: tab.reviewWorkId,
          documentId,
          draftId: tab.reviewDraftId,
          tabInstanceToken: tab.tabInstanceToken,
        }) === "apply-reservation-pending"
      )
        return { kind: "apply-disposition-pending" };
      const identity = {
        documentId,
        tabInstanceId: tab.tabInstanceId,
        reviewWorkId: tab.reviewWorkId,
        reviewDraftId: tab.reviewDraftId,
        tabInstanceToken: tab.tabInstanceToken,
      };
      const consumed = this.desk.closeReviewTab(projectId, identity);
      if (consumed.kind !== "consumed") return { kind: "noop" };
      const state = this.project(projectId);
      const transition = reduceRepresentedRemoval(
        state.selection,
        [tab, ...consumed.current.tabs],
        { cause: "writer-close", documentIds: [documentId] },
      );
      state.selection = transition.selection;
      const outcome = this.executePlanning(projectId, transition.planning, [], {
        removed: [tab],
        current: consumed.current,
      });
      this.publish(state);
      return outcome;
    }
    return this.executeRepresented(projectId, {
      cause: "writer-close",
      documentIds: [documentId],
    });
  }

  /** Owns the synchronous old-Work prune and next-Work route transition. */
  changeWorkSelection(
    projectId: string,
    activeWorkId: string | null,
    locator: ContextRouteTarget | null,
  ): number | null {
    if (this.unavailable()) return null;
    const state = this.project(projectId);
    if (state.activeWorkId === activeWorkId) {
      throw new Error("changeWorkSelection requires an actual Editor Work transition");
    }
    state.activeWorkId = activeWorkId;
    const previousSelection = state.selection;
    const tabs = this.desk.read(projectId).tabs;
    const { documentIds, obsoleteRoutes } = this.readWorkPruneEvidence(
      projectId,
      activeWorkId,
      previousSelection,
    );
    const recentRoutes = this.workingSet.readRecentRoutes(projectId);
    const remainingTabs = tabs.filter((tab) => !documentIds.includes(tab.documentId));
    const targetSelection = activeWorkId
      ? (this.desk.read(projectId).selectedTabIdByWork[activeWorkId] ?? null)
      : null;
    const fallback = chooseAdmittedFallback({
      activeWorkId,
      tabs: remainingTabs,
      selectedTabId: null,
      admitted: state.admitted,
      recentRoutes,
      excluded: null,
      allowDeskFallback: false,
    });
    const transition = supersedeSelectionForWorkChange(
      previousSelection,
      locator,
      locator ? (state.terminalRemovals.get(locatorKey(locator)) ?? null) : null,
    );
    state.selection = transition.selection;
    state.admitted = fallback;

    if (documentIds.length > 0) {
      const represented = reduceRepresentedRemoval(previousSelection, tabs, {
        cause: "work-prune",
        documentIds,
      });
      this.executePlanning(
        projectId,
        { ...represented.planning, current: { kind: "none" }, repair: "never" },
        obsoleteRoutes,
      );
    } else {
      const selectedTab = remainingTabs.find((tab) => tab.documentId === targetSelection) ?? null;
      const compatibleSelected =
        selectedTab &&
        (!isWorkScopedProjectContextScheme(routeTargetForTab(selectedTab, activeWorkId).scheme) ||
          routeTargetForTab(selectedTab, activeWorkId).workId === activeWorkId)
          ? selectedTab
          : null;
      const fallbackTab = fallback
        ? remainingTabs.find((tab) => sameLocator(routeTargetForTab(tab, activeWorkId), fallback))
        : null;
      this.desk.commit(projectId, {
        documentIds: [],
        ...(activeWorkId
          ? {
              deskSelection: {
                workId: activeWorkId,
                documentId: compatibleSelected?.documentId ?? fallbackTab?.documentId ?? null,
              },
            }
          : {}),
      });
      const promotedRoute = fallbackTab ? workingSetRouteForTab(fallbackTab) : null;
      this.workingSet.reconcileContextRoutes(projectId, {
        removedLocators: obsoleteRoutes,
        survivingOwnedLocators: [
          ...remainingTabs.flatMap((tab) => workingSetRouteForTab(tab) ?? []),
          ...(promotedRoute ? [promotedRoute] : []),
        ].filter(
          (route) => !obsoleteRoutes.some((removed) => workingSetRouteEquals(route, removed)),
        ),
        promote: promotedRoute,
        clearAll: false,
      });
    }
    for (const planning of transition.planning) this.executePlanning(projectId, planning);
    this.publish(state);
    return transition.selection.status === "none" ? null : transition.selection.revision;
  }

  async discardDraft(
    projectId: string,
    reviewWorkId: string,
    documentId: string,
  ): Promise<ContextRemovalOutcome> {
    if (this.unavailable()) return { kind: "noop" };
    const slice = this.desk.read(projectId);
    const tab = slice.tabs.find((candidate) => candidate.documentId === documentId);
    if (
      tab === undefined ||
      tab.kind === "new" ||
      !tab.draftOnly ||
      tab.reviewWorkId !== reviewWorkId
    )
      return { kind: "noop" };
    if (!tab.tabInstanceId || !tab.reviewDraftId || !tab.tabInstanceToken) return { kind: "noop" };
    const identity = {
      documentId,
      tabInstanceId: tab.tabInstanceId,
      reviewWorkId,
      reviewDraftId: tab.reviewDraftId,
      tabInstanceToken: tab.tabInstanceToken,
    };
    const settled = await this.desk.settleDraft(projectId, identity, "discarded");
    if (settled.kind !== "settled" || this.unavailable()) return { kind: "noop" };
    const consumed = this.desk.closeReviewTab(projectId, identity);
    if (consumed.kind !== "consumed" || this.unavailable()) return { kind: "noop" };
    const intent = { cause: "draft-discard" as const, documentIds: [documentId] };
    const state = this.project(projectId);
    const transition = reduceRepresentedRemoval(
      state.selection,
      [tab, ...consumed.current.tabs],
      intent,
    );
    state.selection = transition.selection;
    const outcome = this.executePlanning(projectId, transition.planning, [], {
      removed: [tab],
      current: consumed.current,
    });
    this.publish(state);
    return outcome;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const projectId of [...this.projects.keys()]) this.disposeProject(projectId);
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
    );
    state.selection = transition.selection;
    const outcome = this.executePlanning(projectId, transition.planning, additionalRemovedLocators);
    this.publish(state);
    return outcome;
  }

  private readWorkPruneEvidence(
    projectId: string,
    activeWorkId: string | null,
    selection: ContextRouteSelection,
  ): { documentIds: string[]; obsoleteRoutes: WorkingSetRoute[] } {
    const documentIds = this.desk
      .read(projectId)
      .tabs.filter(
        (tab): tab is ServerContextTab =>
          tab.kind !== "new" &&
          (tab.kind !== "tracked" || tab.origin !== "local-untitled") &&
          isWorkScopedProjectContextScheme(tab.scheme) &&
          (tab.workId ?? null) !== activeWorkId,
      )
      .map((tab) => tab.documentId);
    if (
      selection.status === "bound" &&
      selection.identity.kind === "server" &&
      isWorkScopedProjectContextScheme(selection.locator.scheme) &&
      selection.locator.workId !== activeWorkId &&
      !this.desk
        .read(projectId)
        .tabs.some(
          (tab) =>
            tab.kind === "tracked" &&
            tab.origin === "local-untitled" &&
            tab.documentId === selection.identity.documentId,
        ) &&
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
    consumed?: { removed: readonly ContextTab[]; current: ProjectTabsSlice },
  ): ContextRemovalOutcome {
    const { intent, current, cleanup, repair } = effect;
    if (intent.documentIds.length === 0) return { kind: "noop" };
    const slice = consumed?.current ?? this.desk.read(projectId);
    const state = this.project(projectId);
    const plan = planContextRemoval({
      activeWorkId: state.activeWorkId,
      tabs: slice.tabs,
      selectedTabId: state.activeWorkId
        ? (slice.selectedTabIdByWork[state.activeWorkId] ?? null)
        : null,
      admitted: state.admitted,
      route: { cleanup, current },
      intent,
      consumed: consumed
        ? { removed: consumed.removed, survivors: consumed.current.tabs }
        : undefined,
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

    if (!consumed)
      this.desk.commit(projectId, {
        documentIds: plan.outcome.removed.map((tab) => tab.documentId),
        ...(this.project(projectId).activeWorkId
          ? {
              deskSelection: {
                workId: this.project(projectId).activeWorkId as string,
                documentId: plan.nextSelectedTabId,
              },
            }
          : {}),
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

    state.transitionRevision += 1;
    state.admitted = plan.admitted;
    state.removalFence = {
      selectionRevision: current.kind === "none" ? state.selection.revision : current.revision,
      transitionRevision: state.transitionRevision,
      locator:
        current.kind === "none" || !plan.outcome.routedDocumentRemoved ? null : current.locator,
      removedDocumentIds: [...intent.documentIds],
    };
    if (cleanup && (intent.cause === "catalog-unavailable" || intent.cause === "draft-discard")) {
      state.terminalRemovals.set(locatorKey(cleanup.locator), { cleanup, intent });
    }
    this.publish(state);

    if (repair === "allow" && plan.routeRepairTarget && current.kind === "proven-removed") {
      const route = this.routePorts.get(projectId)?.port ?? this.fallbackRoute;
      const search = route?.readSearch(projectId);
      if (
        route &&
        search &&
        contextRouteMatchesSearch(search, current.locator, state.activeWorkId)
      ) {
        const repairPlan: ContextRouteRepair = {
          expectedSearch: {
            screen: "context",
            work: search.work,
            scheme: current.locator.scheme,
            path: current.locator.path,
          },
          expectedSelection: {
            kind: "removed-binding",
            revision: current.revision,
            documentId: current.identity.documentId,
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
      selection.status === "rejected" ||
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
    for (const planning of transition.planning) this.executePlanning(projectId, planning);
    if (transition.rejection) this.executeCandidateRejection(projectId, transition.rejection);
    this.publish(state);
  }

  private executeCandidateRejection(
    projectId: string,
    rejection: Extract<ContextRouteSelection, { status: "rejected" }>,
  ): void {
    const state = this.project(projectId);
    if (
      state.selection.status !== "rejected" ||
      state.selection.revision !== rejection.revision ||
      !sameLocator(state.selection.locator, rejection.locator)
    ) {
      return;
    }
    const slice = this.desk.read(projectId);
    const route = this.routePorts.get(projectId)?.port ?? this.fallbackRoute;
    const search = route?.readSearch(projectId);
    const plan = planCandidateRejection({
      rawRouteWork: search?.work,
      revision: rejection.revision,
      rejected: rejection.locator,
      activeWorkId: state.activeWorkId,
      tabs: slice.tabs,
      selectedTabId: state.activeWorkId
        ? (slice.selectedTabIdByWork[state.activeWorkId] ?? null)
        : null,
      admitted: state.admitted,
      recentRoutes: this.workingSet.readRecentRoutes(projectId),
    });
    if (plan.deskSelection.kind === "select") {
      if (state.activeWorkId) {
        this.desk.commit(projectId, {
          documentIds: [],
          deskSelection: {
            workId: state.activeWorkId,
            documentId: plan.deskSelection.documentId,
          },
        });
      }
    }
    this.workingSet.reconcileContextRoutes(projectId, plan.workingSet);
    state.transitionRevision += 1;
    state.admitted = plan.fallback;
    this.publish(state);

    if (!route || !contextRouteMatchesSearch(search, rejection.locator, state.activeWorkId)) {
      return;
    }
    route.updateSearch(projectId, (latest) =>
      this.candidateStillRejected(projectId, rejection)
        ? applyContextRepairIfCurrent(plan.repair, latest)
        : latest,
    );
  }

  private candidateStillRejected(
    projectId: string,
    rejection: Extract<ContextRouteSelection, { status: "rejected" }>,
  ): boolean {
    const selection = this.project(projectId).selection;
    return (
      selection.status === "rejected" &&
      selection.revision === rejection.revision &&
      sameLocator(selection.locator, rejection.locator)
    );
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
        activeWorkId: null,
        selection: { status: "none", revision: 0 },
        admitted: null,
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
      activeWorkId: state.activeWorkId,
      selection: state.selection,
      admitted: state.admitted,
      removalFence: state.removalFence,
      transitionRevision: state.transitionRevision,
      live: state.live,
    };
    for (const listener of state.listeners) listener();
  }
}

function locatorKey(locator: ContextRouteTarget): string {
  return `${locator.scheme}\u0000${locator.path}\u0000${locator.workId ?? ""}`;
}

function availabilityDocumentId(command: ProjectDocumentAvailabilityCommand): string {
  return command.kind === "available" ? command.document.entryId : command.documentId;
}

function availabilitySessionEffect(
  command: ProjectDocumentAvailabilityCommand,
): PendingSessionAvailabilityEffect[] {
  if (command.kind === "available") return [];
  return [
    {
      commandId: command.commandId,
      operation: command.kind === "terminal-remove" ? "revoke-document" : "revoke-access",
      projectId: command.projectId,
      documentId: command.documentId,
      generation: command.generation,
    },
  ];
}
