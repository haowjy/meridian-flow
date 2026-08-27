/** Exact-identity desk, continuity, and route reconciliation for live removals. */

import type { WorkingSetRoute } from "@meridian/contracts/protocol";

import {
  type ContextTab,
  type ProjectTabsSlice,
  type ServerContextTab,
  useContextTabsStore,
} from "@/client/stores";
import {
  buildWorkingSetRoute,
  type ReconcileContextRoutesInput,
  reconcileContextRoutes,
} from "@/client/working-set";
import {
  applyContextRepairIfCurrent,
  type ContextRouteRepair,
  type ContextRouteTarget,
  type ProjectSearch,
} from "../routing/project-route";
import { contextTabMatchesRoute } from "./context-tab-identity";

export type ContextRemovalIntent = {
  cause: "writer-close" | "acknowledged-delete" | "work-prune" | "draft-discard";
  documentIds: readonly string[];
};

export type ContextRouteSelection =
  | { status: "none"; revision: number }
  | { status: "pending"; revision: number; locator: ContextRouteTarget }
  | {
      status: "bound";
      revision: number;
      locator: ContextRouteTarget;
      selection: { kind: "server" | "local"; documentId: string };
    }
  | { status: "confirmed-unbound"; revision: number; locator: ContextRouteTarget };

export type ContextRemovalOutcome =
  | { kind: "noop" }
  | {
      kind: "inactive-removal";
      removed: readonly ContextTab[];
      deskActiveRemoved: false;
      routedDocumentRemoved: false;
      remaining: readonly ContextTab[];
    }
  | {
      kind: "active-fallback";
      removed: readonly ContextTab[];
      deskActiveRemoved: boolean;
      routedDocumentRemoved: boolean;
      fallback: ContextTab;
      remaining: readonly ContextTab[];
    }
  | {
      kind: "empty-desk";
      removed: readonly ContextTab[];
      deskActiveRemoved: boolean;
      routedDocumentRemoved: boolean;
      remaining: readonly [];
    }
  | {
      kind: "route-only-removal";
      removed: readonly [];
      routedDocumentRemoved: true;
      remaining: readonly ContextTab[];
    };

export type ContextRemovalPlan = {
  outcome: ContextRemovalOutcome;
  nextActiveTabId: string | null;
  routeRepairTarget: ContextRouteTarget | { kind: "clear" } | null;
  workingSet: ReconcileContextRoutesInput;
};

export type ContextRemovalPlannerInput = {
  tabs: readonly ContextTab[];
  activeTabId: string | null;
  routeSelection: ContextRouteSelection;
  intent: ContextRemovalIntent;
};

export type ContextRemovalWorkingSetPort = {
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
  autoOpenBlock: { selectionRevision: number; documentIds: readonly string[] } | null;
  deferred: Map<number, DeferredRemoval[]>;
};

const EMPTY_SLICE: ProjectTabsSlice = { tabs: [], activeTabId: null };

const productionDesk: DeskPort = {
  read: (projectId) => useContextTabsStore.getState().byProject[projectId] ?? EMPTY_SLICE,
  commit: (projectId, input) =>
    useContextTabsStore.getState().commitContextRemoval(projectId, input),
  resolveDraftApply: (projectId, reviewWorkId, documentId) =>
    useContextTabsStore
      .getState()
      .resolveDraftOnlyTabCommitted(projectId, reviewWorkId, documentId),
};

const productionWorkingSet: ContextRemovalWorkingSetPort = {
  reconcileContextRoutes,
};

function eligible(tab: ContextTab, intent: ContextRemovalIntent): boolean {
  if (!intent.documentIds.includes(tab.documentId)) return false;
  switch (intent.cause) {
    case "writer-close":
      return true;
    case "acknowledged-delete":
      return tab.kind !== "new" && !tab.draftOnly;
    case "work-prune":
      return tab.kind !== "new";
    case "draft-discard":
      return tab.kind !== "new" && tab.draftOnly === true;
  }
}

function routeForTab(tab: ContextTab): WorkingSetRoute | null {
  return tab.kind === "new" ? null : buildWorkingSetRoute(tab.scheme, tab.path, tab.workId);
}

function targetForTab(tab: ContextTab, workId: string | null): ContextRouteTarget {
  return tab.kind === "new"
    ? { scheme: "scratch", path: "", workId }
    : { scheme: tab.scheme, path: tab.path, workId: tab.workId ?? null };
}

function tabAtSelection(
  tabs: readonly ContextTab[],
  selection: Extract<ContextRouteSelection, { status: "bound" }>,
): ContextTab | null {
  return tabs.find((tab) => tab.documentId === selection.selection.documentId) ?? null;
}

function adjacentSurvivor(
  tabs: readonly ContextTab[],
  remaining: readonly ContextTab[],
  anchorDocumentId: string | null,
): ContextTab | null {
  if (!anchorDocumentId) return remaining[0] ?? null;
  const anchor = tabs.findIndex((tab) => tab.documentId === anchorDocumentId);
  if (anchor < 0) return remaining[0] ?? null;
  const surviving = new Set(remaining.map((tab) => tab.documentId));
  return (
    tabs.slice(anchor + 1).find((tab) => surviving.has(tab.documentId)) ??
    tabs
      .slice(0, anchor)
      .reverse()
      .find((tab) => surviving.has(tab.documentId)) ??
    null
  );
}

/** Pure removal policy. Query-tree/cache state is intentionally not an input. */
export function planContextRemoval(input: ContextRemovalPlannerInput): ContextRemovalPlan {
  const requested = new Set(input.intent.documentIds);
  const removed = input.tabs.filter((tab) => eligible(tab, input.intent));
  const removedIds = new Set(removed.map((tab) => tab.documentId));
  const remaining = input.tabs.filter((tab) => !removedIds.has(tab.documentId));
  const deskActiveRemoved = input.activeTabId !== null && removedIds.has(input.activeTabId);
  const boundSelection = input.routeSelection.status === "bound" ? input.routeSelection : null;
  const routedDocumentRemoved =
    boundSelection !== null &&
    requested.has(boundSelection.selection.documentId) &&
    (removedIds.has(boundSelection.selection.documentId) ||
      (input.intent.cause === "acknowledged-delete" &&
        boundSelection.selection.kind === "server" &&
        !input.tabs.some((tab) => tab.documentId === boundSelection.selection.documentId)));

  if (removed.length === 0 && !routedDocumentRemoved) {
    return {
      outcome: { kind: "noop" },
      nextActiveTabId: input.activeTabId,
      routeRepairTarget: null,
      workingSet: {
        removedLocators: [],
        survivingOwnedLocators: input.tabs.flatMap((tab) => routeForTab(tab) ?? []),
        promote: null,
        clearAll: false,
      },
    };
  }

  const routedTab = boundSelection ? tabAtSelection(input.tabs, boundSelection) : null;
  const survivingRoutedTab =
    boundSelection && !routedDocumentRemoved
      ? (remaining.find((tab) => tab.documentId === boundSelection.selection.documentId) ?? null)
      : null;
  const anchorDocumentId = routedDocumentRemoved
    ? (routedTab?.documentId ?? null)
    : deskActiveRemoved
      ? input.activeTabId
      : null;
  const fallback =
    routedDocumentRemoved || deskActiveRemoved
      ? adjacentSurvivor(input.tabs, remaining, anchorDocumentId)
      : null;
  const selectedFallback = deskActiveRemoved && survivingRoutedTab ? survivingRoutedTab : fallback;
  const nextActiveTabId = deskActiveRemoved
    ? (selectedFallback?.documentId ?? null)
    : routedDocumentRemoved
      ? (fallback?.documentId ?? null)
      : input.activeTabId;
  const removedLocators = removed.flatMap((tab) => routeForTab(tab) ?? []);
  const survivingOwnedLocators = remaining.flatMap((tab) => routeForTab(tab) ?? []);
  const promotedTab = survivingRoutedTab ?? fallback;
  const promote = promotedTab ? routeForTab(promotedTab) : null;
  const routeRepairTarget = routedDocumentRemoved
    ? fallback
      ? targetForTab(fallback, boundSelection?.locator.workId ?? null)
      : { kind: "clear" as const }
    : null;

  let outcome: ContextRemovalOutcome;
  if (removed.length === 0) {
    outcome = { kind: "route-only-removal", removed: [], routedDocumentRemoved: true, remaining };
  } else if (!deskActiveRemoved && !routedDocumentRemoved) {
    outcome = {
      kind: "inactive-removal",
      removed,
      deskActiveRemoved: false,
      routedDocumentRemoved: false,
      remaining,
    };
  } else if (remaining.length === 0) {
    outcome = {
      kind: "empty-desk",
      removed,
      deskActiveRemoved,
      routedDocumentRemoved,
      remaining: [],
    };
  } else {
    outcome = {
      kind: "active-fallback",
      removed,
      deskActiveRemoved,
      routedDocumentRemoved,
      fallback: selectedFallback ?? (remaining[0] as ContextTab),
      remaining,
    };
  }
  return {
    outcome,
    nextActiveTabId,
    routeRepairTarget,
    workingSet: {
      removedLocators,
      survivingOwnedLocators,
      promote,
      clearAll: outcome.kind === "empty-desk",
    },
  };
}

export class ContextRemovalCoordinator {
  private readonly projects = new Map<string, CoordinatorProjectState>();
  private readonly routePorts = new Map<string, ContextRemovalRoutePort>();
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

  registerRoutePort(projectId: string, port: ContextRemovalRoutePort): () => void {
    this.routePorts.set(projectId, port);
    return () => {
      if (this.routePorts.get(projectId) === port) this.routePorts.delete(projectId);
    };
  }

  beginRouteSelection(projectId: string, locator: ContextRouteTarget): number {
    const state = this.project(projectId);
    const revision = state.selection.revision + 1;
    state.selection = { status: "pending", revision, locator };
    for (const [staleRevision, deferred] of state.deferred) {
      if (staleRevision === revision) continue;
      state.deferred.delete(staleRevision);
      for (const command of deferred) {
        this.executeNow(projectId, command.intent, { status: "none", revision }).then(
          command.resolve,
        );
      }
    }
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
    this.drainDeferred(projectId, revision);
    return true;
  }

  confirmRouteUnbound(projectId: string, revision: number): boolean {
    const state = this.project(projectId);
    if (state.selection.status !== "pending" || state.selection.revision !== revision) return false;
    state.selection = { ...state.selection, status: "confirmed-unbound" };
    this.drainDeferred(projectId, revision);
    return true;
  }

  clearRouteSelection(projectId: string): void {
    const state = this.project(projectId);
    const staleRevision = state.selection.revision;
    const revision = staleRevision + 1;
    state.selection = { status: "none", revision };
    const deferred = state.deferred.get(staleRevision);
    if (!deferred) return;
    state.deferred.delete(staleRevision);
    for (const command of deferred) {
      this.executeNow(projectId, command.intent, state.selection).then(command.resolve);
    }
  }

  getRouteSelection(projectId: string): ContextRouteSelection {
    return this.project(projectId).selection;
  }

  getProjectSnapshot(
    projectId: string,
  ): Pick<CoordinatorProjectState, "rememberedRoute" | "autoOpenBlock"> {
    const state = this.project(projectId);
    return { rememberedRoute: state.rememberedRoute, autoOpenBlock: state.autoOpenBlock };
  }

  resolveDraftApply(projectId: string, reviewWorkId: string, documentId: string): void {
    this.desk.resolveDraftApply(projectId, reviewWorkId, documentId);
  }

  executeContextRemoval(
    projectId: string,
    intent: ContextRemovalIntent,
  ): Promise<ContextRemovalOutcome> {
    const state = this.project(projectId);
    if (
      intent.cause === "acknowledged-delete" &&
      state.selection.status === "pending" &&
      this.pendingLocatorMayOwnRemoval(projectId, state.selection, intent)
    ) {
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
    const activeTab = plan.outcome.remaining.find((tab) => tab.documentId === plan.nextActiveTabId);
    state.rememberedRoute = activeTab
      ? targetForTab(
          activeTab,
          routeSelection.status === "bound" ? routeSelection.locator.workId : null,
        )
      : null;
    state.autoOpenBlock = {
      selectionRevision: routeSelection.revision,
      documentIds: [...intent.documentIds],
    };

    if (
      plan.routeRepairTarget &&
      routeSelection.status === "bound" &&
      this.selectionStillCurrent(projectId, routeSelection)
    ) {
      const route = this.routePorts.get(projectId) ?? this.fallbackRoute;
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
    return this.desk
      .read(projectId)
      .tabs.some(
        (tab): tab is ServerContextTab =>
          tab.kind !== "new" &&
          eligible(tab, intent) &&
          contextTabMatchesRoute(
            tab,
            pending.locator.scheme,
            pending.locator.path,
            pending.locator.workId,
          ),
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

  private project(projectId: string): CoordinatorProjectState {
    let state = this.projects.get(projectId);
    if (!state) {
      state = {
        selection: { status: "none", revision: 0 },
        rememberedRoute: null,
        autoOpenBlock: null,
        deferred: new Map(),
      };
      this.projects.set(projectId, state);
    }
    return state;
  }
}

export const contextRemovalCoordinator = new ContextRemovalCoordinator();
