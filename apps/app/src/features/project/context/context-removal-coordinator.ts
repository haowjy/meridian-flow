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
  contextTabEligibleForRemoval,
  planContextRemoval,
  type RouteContinuityVerdict,
  routeTargetForTab,
  workingSetRouteForTab,
} from "./context-removal-planner";
import {
  type AcknowledgedContextDeleteCommand,
  type AcknowledgedDeleteAdmission,
  admitCommand,
  attachObligation,
  beginSelection,
  bindSelection,
  type CommandAdmissionRecord,
  type ContextDeleteInitiator,
  type ContextRouteSelection,
  confirmSelectionUnbound,
  continuityForSelection,
  deleteProof,
  type InitiatingRouteWitness,
  type RouteRemovalProof,
  type SelectionTransition,
  type SettledObligation,
  sameLocator,
} from "./context-removal-protocol";
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
  live: boolean;
  listeners: Set<() => void>;
  snapshot: ContextRemovalProjectSnapshot;
};

export type ContextRemovalProjectSnapshot = Pick<
  CoordinatorProjectState,
  "selection" | "rememberedRoute" | "removalFence" | "transitionRevision" | "live"
>;

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

  activate(activation: ContextActivation): boolean {
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
        this.disposeProject(projectId);
      },
    };
  }

  beginRouteSelection(projectId: string, locator: ContextRouteTarget): number {
    const state = this.project(projectId);
    const transition = beginSelection(state.selection, locator);
    this.applySelectionTransition(projectId, transition);
    this.promoteUnknown(projectId, locator);
    return transition.selection.revision;
  }

  bindRouteSelection(projectId: string, revision: number, identity: ContextRouteIdentity): boolean {
    const transition = bindSelection(this.project(projectId).selection, revision, identity);
    if (!transition) return false;
    this.applySelectionTransition(projectId, transition);
    return true;
  }

  confirmRouteUnbound(projectId: string, revision: number): boolean {
    const transition = confirmSelectionUnbound(this.project(projectId).selection, revision);
    if (!transition) return false;
    this.applySelectionTransition(projectId, transition);
    return true;
  }

  clearRouteSelection(projectId: string): void {
    this.leaveSelection(projectId);
  }

  subscribe(projectId: string, listener: () => void): () => void {
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
    const selection = this.project(projectId).selection;
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
    const state = this.project(command.projectId);
    const proof = deleteProof(command);
    if (
      command.initiated.kind === "file" &&
      !command.confirmed.deletedDocumentIds.includes(command.initiated.documentId)
    ) {
      return { status: "rejected", reason: "invalid_proof" };
    }
    const obligated =
      proof?.kind === "acknowledged-delete" &&
      state.selection.status === "pending" &&
      state.selection.revision === proof.witnessedRevision &&
      sameLocator(state.selection.locator, proof.locator);
    const first: Extract<AcknowledgedDeleteAdmission, { status: "accepted" }> = {
      status: "accepted",
      outcome: obligated ? "obligated" : "executed",
    };
    const admitted = admitCommand(this.commandAdmissions, command, first);
    if (admitted.admission.status !== "accepted") return admitted.admission;
    this.commandAdmissions = admitted.records;

    let continuity = continuityForSelection(state.selection);
    let repair: "allow" | "never" = "allow";
    if (proof) {
      const witness = command.routeWitness;
      if (obligated) {
        state.selection = attachObligation(state.selection, proof, proof.witnessedRevision);
        continuity = continuityForSelection(state.selection);
      } else if (
        witness &&
        witness.revision === state.selection.revision &&
        sameLocator(witness.locator, proof.locator)
      ) {
        if (state.selection.status === "bound") {
          continuity =
            state.selection.identity.documentId === proof.documentId
              ? {
                  kind: "proven-removed",
                  revision: state.selection.revision,
                  locator: state.selection.locator,
                  identity: state.selection.identity,
                }
              : continuityForSelection(state.selection);
        } else if (state.selection.status === "confirmed-unbound") {
          continuity = {
            kind: "proven-removed",
            revision: state.selection.revision,
            locator: state.selection.locator,
            identity: { kind: "server", documentId: proof.documentId },
          };
        }
      } else if (witness) {
        continuity = {
          kind: "proven-removed",
          revision: witness.revision,
          locator: witness.locator,
          identity: { kind: "server", documentId: proof.documentId },
        };
        repair = "never";
      }
    }
    this.executeNow(
      command.projectId,
      { cause: "acknowledged-delete", documentIds: command.confirmed.deletedDocumentIds },
      continuity,
      repair,
    );
    this.publish(state);
    return first;
  }

  applyDraftMetadata(projectId: string, reviewWorkId: string, documentId: string): void {
    this.desk.resolveDraftApply(projectId, reviewWorkId, documentId);
  }

  writerClose(projectId: string, documentId: string): ContextRemovalOutcome {
    return this.executeRepresented(projectId, {
      cause: "writer-close",
      documentIds: [documentId],
    });
  }

  pruneWork(projectId: string, activeWorkId: string): ContextRemovalOutcome {
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
    return this.executeRepresented(projectId, { cause: "work-prune", documentIds });
  }

  discardDraft(projectId: string, reviewWorkId: string, documentId: string): ContextRemovalOutcome {
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
  ): ContextRemovalOutcome {
    const state = this.project(projectId);
    if (intent.documentIds.length === 0) return { kind: "noop" };
    if (state.selection.status === "pending") {
      const represented = this.desk.read(projectId).tabs.find((tab) => {
        if (!contextTabEligibleForRemoval(tab, intent)) return false;
        if (tab.kind === "new")
          return (
            state.selection.status === "pending" &&
            state.selection.locator.scheme === "scratch" &&
            state.selection.locator.path === ""
          );
        return (
          state.selection.status === "pending" &&
          contextTabMatchesRoute(
            tab,
            state.selection.locator.scheme,
            state.selection.locator.path,
            state.selection.locator.workId,
          )
        );
      });
      if (represented) {
        const proof: RouteRemovalProof = {
          kind: "represented-tab",
          commandId: newCommandId(),
          cause: intent.cause as "writer-close" | "work-prune" | "draft-discard",
          locator: state.selection.locator,
          documentId: represented.documentId,
        };
        state.selection = attachObligation(state.selection, proof, state.selection.revision);
      }
    }
    const outcome = this.executeNow(
      projectId,
      intent,
      continuityForSelection(state.selection),
      "allow",
    );
    this.publish(state);
    return outcome;
  }

  private executeNow(
    projectId: string,
    intent: ContextRemovalIntent,
    continuity: RouteContinuityVerdict,
    repair: "allow" | "never",
  ): ContextRemovalOutcome {
    if (intent.documentIds.length === 0) return { kind: "noop" };
    const slice = this.desk.read(projectId);
    const plan = planContextRemoval({
      ...slice,
      routeContinuity: continuity,
      intent,
    });
    if (plan.outcome.kind === "noop") return plan.outcome;

    this.desk.commit(projectId, {
      documentIds: plan.outcome.removed.map((tab) => tab.documentId),
      activeTabId: plan.nextActiveTabId,
    });
    this.workingSet.reconcileContextRoutes(projectId, plan.workingSet);

    const state = this.project(projectId);
    state.transitionRevision += 1;
    state.rememberedRoute = plan.rememberedRoute;
    state.removalFence = {
      selectionRevision:
        continuity.kind === "none" ? state.selection.revision : continuity.revision,
      transitionRevision: state.transitionRevision,
      locator:
        continuity.kind === "none" || !plan.outcome.routedDocumentRemoved
          ? null
          : continuity.locator,
      removedDocumentIds: [...intent.documentIds],
    };
    this.publish(state);

    if (repair === "allow" && plan.routeRepairTarget && continuity.kind === "proven-removed") {
      const route = this.routePorts.get(projectId)?.port ?? this.fallbackRoute;
      const search = route?.readSearch(projectId);
      if (
        route &&
        search?.screen === "context" &&
        search.scheme === continuity.locator.scheme &&
        search.path === continuity.locator.path &&
        (search.work ?? null) === continuity.locator.workId
      ) {
        const repairPlan: ContextRouteRepair = {
          expected: {
            screen: "context",
            work: search.work,
            scheme: continuity.locator.scheme,
            path: continuity.locator.path,
            selectionRevision: continuity.revision,
            selectionDocumentId: continuity.identity.documentId,
          },
          next: plan.routeRepairTarget,
        };
        route.updateSearch(projectId, (latest) =>
          this.removalStillCurrent(projectId, continuity)
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
    for (const preserved of transition.preserve) {
      if (preserved.kind !== "none") this.promoteUnknown(projectId, preserved.locator);
    }
    for (const settled of transition.settled) this.executeSettled(projectId, settled);
    this.publish(state);
  }

  private executeSettled(projectId: string, settled: SettledObligation): void {
    this.executeNow(projectId, settled.intent, settled.continuity, settled.repair);
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
    if (state.selection.status === "pending") {
      const leaving = beginSelection(state.selection, state.selection.locator);
      for (const settled of leaving.settled) this.executeSettled(projectId, settled);
      for (const preserved of leaving.preserve) {
        if (preserved.kind !== "none") this.promoteUnknown(projectId, preserved.locator);
      }
    }
    state.selection = { status: "none", revision: state.selection.revision + 1 };
    state.live = false;
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
