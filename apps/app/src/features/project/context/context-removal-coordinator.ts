/** Account-lifetime effect shell for exact context removal transitions. */

import type { ProjectContextTreeScheme, WorkingSetRoute } from "@meridian/contracts/protocol";
import type { OpenDocument } from "@/client/stores";
import {
  type ReconcileContextRoutesInput,
  readRecentRoutes,
  reconcileContextRoutes,
  replaceRecentRoutes,
  workingSetRouteEquals,
} from "@/client/working-set";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import type {
  NavigationSettlement,
  PreparedWorkspaceNavigation,
} from "../routing/project-navigation";
import {
  applyContextRepairIfCurrent,
  type ContextRouteRepair,
  type ContextRouteRequest,
  contextRouteMatchesSearch,
  type ProjectSearch,
} from "../routing/project-route";
import { planContextRemovalBatch } from "./context-removal-batch-planner";
import {
  type ContextRemovalOutcome,
  type ContextRouteIdentity,
  planCandidateRejection,
  planContextRemoval,
  routeTargetForTab,
  workingSetRouteForTab,
  workingSetRouteForTarget,
} from "./context-removal-planner";
import {
  adoptReviewBinding,
  beginSelection,
  bindSelection,
  type ContextRouteSelection,
  leaveSelection,
  type RemovalPlanningEffect,
  type RouteBindingProof,
  type RouteOwner,
  reduceRepresentedRemoval,
  rejectSelection,
  type SelectionTransition,
  sameLocator,
  selectionAtRoute,
  type TerminalRouteRemoval,
} from "./context-removal-protocol";
import { PresentedDocuments } from "./presented-documents";
import type { RemovedNoticeStore } from "./removed-notice-store";

type ContextRemovalWorkingSetPort = {
  readRecentRoutes(projectId: string): WorkingSetRoute[];
  reconcileContextRoutes(projectId: string, input: ReconcileContextRoutesInput): WorkingSetRoute[];
  replaceRecentRoutes(projectId: string, routes: readonly WorkingSetRoute[]): WorkingSetRoute[];
};

/** Where main went: a document, or Recently opened (`documentId` null). */
export type MainLanding = { documentId: string | null };

export type ContextRemovalRoutePort = {
  readSearch(projectId: string): ProjectSearch;
  updateSearch(
    projectId: string,
    update: (latest: ProjectSearch) => ProjectSearch,
    /** Set when the update moves this same document to a new locator rather than replacing it. */
    relocated?: { documentId: string },
  ): void;
  transition(
    projectId: string,
    target: ContextRouteRequest | { kind: "clear" },
    prepared: PreparedWorkspaceNavigation,
  ): Promise<NavigationSettlement>;
  /**
   * The writer is removing `documentId`, which main shows: main opens the document it showed
   * before, one that still exists and is not among `removing`, else Recently opened. Nothing
   * moves once `isCurrent` turns false. Resolves to where main landed (`documentId` null:
   * Recently opened); null when it did not move.
   */
  goBack(
    projectId: string,
    documentId: string,
    removing: readonly string[],
    isCurrent: () => boolean,
  ): Promise<MainLanding | null>;
};

/**
 * What the views present (`PresentedDocuments`). A removal is planned against it; the views
 * follow the address and the replica. A close, a Discard or a removal forgets the document, so
 * no view picks it again and its host unmounts.
 */
type PresentedPort = Pick<PresentedDocuments, "documents" | "mainDocumentId" | "forget">;

/** The tabs main holds, kept outside the coordinator: a forgotten document's tab closes with it. */
export type ClosedTabsPort = {
  close(projectId: string, documentIds: readonly string[]): void;
};

/**
 * The cached answers to "what lives at this address". Kept by a query cache that outlives a
 * removal: an answer from before it would paint the document again.
 */
export type AddressAnswersPort = {
  /** Live no longer has these documents: an answer naming one is now "unavailable". */
  removed(projectId: string, documentIds: readonly string[]): void;
  /** Live has a document again: every answer is read afresh. */
  available(projectId: string): void;
};

/** The draft-only documents hosts present (`DraftOnlyPresentations`). */
export type DraftOnlyPort = {
  isDraftOnly(projectId: string, documentId: string): boolean;
  holdRemovedLive(
    projectId: string,
    documentId: string,
    drafts: readonly {
      projectId: string;
      documentId: string;
      ownerKey: string;
      itemKey: string;
      contextLocation: { scheme: ProjectContextTreeScheme; path: string };
    }[],
  ): void;
  promote(projectId: string, documentId: string): void;
};

/**
 * The drafts of a document some surface holds open and its view shows: only those keep it when
 * live deletes it. A draft held open but not shown paints nothing.
 */
export type BoundDraftsPort = {
  boundDrafts(
    projectId: string,
    documentId: string,
  ): readonly { ownerKey: string; itemKey: string }[];
};

type RemovalFence = {
  selectionRevision: number;
  transitionRevision: number;
  locator: ContextRouteRequest | null;
  removedDocumentIds: readonly string[];
};

export type ContextRouteActivation = {
  projectId: string;
  selectionRevision: number;
  transitionRevision: number;
  locator: ContextRouteRequest;
  identity: ContextRouteIdentity;
};

/** Where views report documents they presented that vanished (`RemovedNoticeStore`). */
export type RemovedPresentationPort = Pick<RemovedNoticeStore, "presentedRemoved">;

type CoordinatorProjectState = {
  activeWorkId: string | null;
  selection: ContextRouteSelection;
  admitted: ContextRouteRequest | null;
  removalFence: RemovalFence | null;
  transitionRevision: number;
  terminalRemovals: Map<string, TerminalRouteRemoval>;
  /** Documents whose own removal is still sending main back: their draft's end closes nothing. */
  goingBack: Set<string>;
  live: boolean;
  listeners: Set<() => void>;
  snapshot: ContextRemovalProjectSnapshot;
};

export type ContextRemovalProjectSnapshot = Pick<
  CoordinatorProjectState,
  "activeWorkId" | "selection" | "admitted" | "removalFence" | "transitionRevision" | "live"
>;

/**
 * What the list says changed for a document in a project: it left the live tree (deleted, purged
 * or never there), or it is in the tree again (a restore).
 */
export type RemovalCommand = Readonly<{
  kind: "gone" | "back";
  projectId: string;
  documentId: string;
}>;

export type ContextRemovalLifetimeLease = {
  suspend(): void;
  resume(): void;
  disposeIfSuspended(): boolean;
};

const EMPTY_PROJECT_SNAPSHOT: ContextRemovalProjectSnapshot = {
  activeWorkId: null,
  selection: { status: "none", revision: 0 },
  admitted: null,
  removalFence: null,
  transitionRevision: 0,
  live: false,
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
  private readonly presented: PresentedPort;
  private readonly workingSet: ContextRemovalWorkingSetPort;
  private readonly copies: Pick<LiveDocumentSessionRegistry, "clearLocalCopy"> | null;
  private readonly notices: RemovedPresentationPort | null;
  private readonly drafts: BoundDraftsPort | null;
  private readonly draftOnly: DraftOnlyPort | null;
  private readonly addresses: AddressAnswersPort | null;
  private readonly tabs: ClosedTabsPort | null;
  /** The documents the list has taken out of the live tree and has not given back, by `projectId/documentId`. */
  private readonly gone = new Set<string>();
  private disposed = false;
  private suspended = false;

  readonly accountId: string | null;

  constructor(
    accountOrDependencies:
      | string
      | {
          presented?: PresentedPort;
          workingSet?: ContextRemovalWorkingSetPort;
          route?: ContextRemovalRoutePort;
          copies?: Pick<LiveDocumentSessionRegistry, "clearLocalCopy">;
          notices?: RemovedPresentationPort;
          drafts?: BoundDraftsPort;
          draftOnly?: DraftOnlyPort;
          addresses?: AddressAnswersPort;
          tabs?: ClosedTabsPort;
        }
      | null = null,
    explicitDependencies: {
      presented?: PresentedPort;
      workingSet?: ContextRemovalWorkingSetPort;
      route?: ContextRemovalRoutePort;
      copies?: Pick<LiveDocumentSessionRegistry, "clearLocalCopy">;
      notices?: RemovedPresentationPort;
      drafts?: BoundDraftsPort;
      draftOnly?: DraftOnlyPort;
      addresses?: AddressAnswersPort;
      tabs?: ClosedTabsPort;
    } = {},
  ) {
    const dependencies =
      typeof accountOrDependencies === "object" && accountOrDependencies !== null
        ? accountOrDependencies
        : explicitDependencies;
    this.accountId = typeof accountOrDependencies === "string" ? accountOrDependencies : null;
    this.presented = dependencies.presented ?? new PresentedDocuments();
    this.workingSet = dependencies.workingSet ?? productionWorkingSet;
    this.fallbackRoute = dependencies.route ?? null;
    this.copies = dependencies.copies ?? null;
    this.notices = dependencies.notices ?? null;
    this.drafts = dependencies.drafts ?? null;
    this.draftOnly = dependencies.draftOnly ?? null;
    this.addresses = dependencies.addresses ?? null;
    this.tabs = dependencies.tabs ?? null;
  }

  /** These documents are closed, Discarded or removed: no view picks them again and their tabs close. */
  private forget(projectId: string, documentIds: readonly string[]): void {
    this.presented.forget(projectId, documentIds);
    this.tabs?.close(projectId, documentIds);
  }

  /**
   * The documents among `documentIds` a view keeps when live loses them: a host presents the
   * document draft-only, or a draft held open still has it: a live delete must not strand the
   * draft. The draft paints there; a held live document stays draft-only while a held draft has
   * it, until it ends or live has the document again. The hold's location is the view's.
   */
  private heldByDrafts(projectId: string, documentIds: readonly string[]): Set<string> {
    const held = new Set<string>();
    for (const documentId of documentIds) {
      if (this.draftOnly?.isDraftOnly(projectId, documentId)) {
        held.add(documentId);
        continue;
      }
      const drafts = this.drafts?.boundDrafts(projectId, documentId) ?? [];
      if (!drafts.length) continue;
      held.add(documentId);
      const tab = this.presented
        .documents(projectId)
        .find((candidate) => candidate.documentId === documentId);
      const contextLocation =
        tab?.kind === "tracked" ? { scheme: tab.scheme, path: tab.path } : null;
      this.draftOnly?.holdRemovedLive(
        projectId,
        documentId,
        contextLocation
          ? drafts.map((draft) => ({ ...draft, projectId, documentId, contextLocation }))
          : [],
      );
    }
    return held;
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
    const tabs = this.presented.documents(activation.projectId);
    const route = this.routePorts.get(activation.projectId)?.port ?? this.fallbackRoute;
    const search = route?.readSearch(activation.projectId);
    if (
      activation.identity.kind !== "server" ||
      this.draftOnly?.isDraftOnly(activation.projectId, activation.identity.documentId) ||
      !contextRouteMatchesSearch(search, activation.locator)
    ) {
      return false;
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
    const activated = workingSetRouteForTarget(activation.identity.documentId, activation.locator);
    if (activated) {
      this.workingSet.reconcileContextRoutes(activation.projectId, {
        removedLocators: [],
        survivingOwnedLocators: [
          ...tabs.flatMap((item) => workingSetRouteForTab(item) ?? []),
          activated,
        ],
        promote: activated,
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
    target: ContextRouteRequest,
  ): boolean {
    if (this.unavailable()) return false;
    const state = this.project(projectId);
    const selection = state.selection;
    const workId = state.activeWorkId;
    const tab = this.presented
      .documents(projectId)
      .find((candidate) => candidate.documentId === documentId);
    if (
      !workId ||
      !state.live ||
      selection.status === "none" ||
      selection.revision !== selectionRevision ||
      selection.locator.scheme !== "unfiled" ||
      selection.locator.path !== "" ||
      selection.locator.workId !== workId ||
      this.presented.mainDocumentId(projectId) !== documentId ||
      tab?.kind !== "tracked" ||
      tab.origin !== "local-resource" ||
      !sameLocator(routeTargetForTab(tab), target)
    ) {
      return false;
    }
    const route = this.routePorts.get(projectId)?.port ?? this.fallbackRoute;
    const search = route?.readSearch(projectId);
    if (!route || !search?.scheme) return false;
    const repair: ContextRouteRepair = {
      expectedSearch: {
        work: search.work,
        chat: search.chat,
        scheme: "unfiled",
        path: "",
      },
      expectedSelection: { kind: "materialized-local", revision: selectionRevision, documentId },
      next: target,
    };
    route.updateSearch(projectId, (latest) => {
      const current = this.project(projectId);
      return current.selection.status !== "none" &&
        current.selection.revision === selectionRevision &&
        this.presented.mainDocumentId(projectId) === documentId
        ? applyContextRepairIfCurrent(repair, latest)
        : latest;
    });
    return true;
  }

  registerRoutePort(
    projectId: string,
    port: ContextRemovalRoutePort,
    activeWorkId: string,
  ): { token: symbol; release: () => void } {
    if (this.unavailable()) return { token: Symbol(projectId), release: () => undefined };
    const state = this.project(projectId);
    const token = Symbol(projectId);
    this.routePorts.set(projectId, { token, port });
    state.live = true;
    state.activeWorkId = activeWorkId;
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

  beginRouteSelection(projectId: string, locator: ContextRouteRequest): number {
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

  /** A navigation or review that names a document binds the route it opens: the id is proof. */
  enterRoute(
    projectId: string,
    locator: ContextRouteRequest,
    documentId: string,
    by: RouteBindingProof,
  ): void {
    const { selection } = this.project(projectId);
    if (
      selection.status === "bound" &&
      selection.by === by &&
      selection.identity.documentId === documentId &&
      sameLocator(selection.locator, locator)
    )
      return;
    this.bindRouteSelection(
      projectId,
      this.beginRouteSelection(projectId, locator),
      { kind: "server", documentId },
      by,
    );
  }

  /**
   * The bound document is not where the route held it: the address answer decides again. A
   * selection that has moved on since the question was asked is left alone.
   */
  unbindRoute(projectId: string, documentId: string, route: RouteOwner): void {
    const { selection } = this.project(projectId);
    if (
      selection.status !== "bound" ||
      selection.identity.documentId !== documentId ||
      !selectionAtRoute(selection, route)
    )
      return;
    this.leaveSelection(projectId);
    this.beginRouteSelection(projectId, selection.locator);
  }

  /** The writer left a review or closed its draft: the route stays bound to the document. */
  adoptReviewBinding(projectId: string): void {
    if (this.unavailable()) return;
    const transition = adoptReviewBinding(this.project(projectId).selection);
    if (transition) this.applySelectionTransition(projectId, transition);
  }

  bindRouteSelection(
    projectId: string,
    revision: number,
    identity: ContextRouteIdentity,
    by: RouteBindingProof,
  ): boolean {
    if (this.unavailable()) return false;
    const transition = bindSelection(this.project(projectId).selection, revision, identity, by);
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

  /** The documents of the project a removal can touch: the ones views present and recent routes name. */
  watchedDocumentIds(projectId: string): string[] {
    const ids = new Set(this.presented.documents(projectId).map((tab) => tab.documentId));
    for (const route of this.workingSet.readRecentRoutes(projectId))
      if (route.documentId) ids.add(route.documentId);
    return [...ids];
  }

  /**
   * What the list says changed, as one batch across workspace, route, recent routes and
   * selection. A document already gone stays gone: the batch repeats nothing.
   */
  applyRemovals(commands: readonly RemovalCommand[]): void {
    if (this.unavailable()) return;
    for (const projectId of new Set(commands.map((command) => command.projectId))) {
      const mine = commands.filter((command) => command.projectId === projectId);
      const key = (command: RemovalCommand) => `${projectId}/${command.documentId}`;
      const removed = mine.filter(
        (command) => command.kind === "gone" && !this.gone.has(key(command)),
      );
      const restored = mine.filter(
        (command) => command.kind === "back" && this.gone.delete(key(command)),
      );
      if (removed.length > 0)
        this.applyGone(
          projectId,
          removed.map((command) => command.documentId),
        );
      if (restored.length > 0) {
        // The documents are in the tree again: their holds end and every cached address is read afresh.
        for (const command of restored) this.draftOnly?.promote(projectId, command.documentId);
        this.addresses?.available(projectId);
      }
    }
  }

  /**
   * A view can present a document after the removal that raced its route. Apply the removal again
   * to the newly presented document instead of leaving it outside the batch already settled.
   */
  reconcileInstalledTab(projectId: string, tab: OpenDocument): void {
    if (tab.kind === "new" || !this.gone.has(`${projectId}/${tab.documentId}`)) return;
    this.applyGone(projectId, [tab.documentId]);
  }

  private applyGone(projectId: string, documentIds: readonly string[]): void {
    for (const documentId of documentIds) this.gone.add(`${projectId}/${documentId}`);
    const state = this.project(projectId);
    const held = this.heldByDrafts(projectId, documentIds);
    for (const documentId of documentIds)
      if (this.draftOnly?.isDraftOnly(projectId, documentId)) held.add(documentId);
    const presented = this.presented.documents(projectId);
    const plan = planContextRemovalBatch({
      documentIds,
      project: state.snapshot,
      tabs: presented,
      mainDocumentId: this.presented.mainDocumentId(projectId),
      recentRoutes: this.workingSet.readRecentRoutes(projectId),
      held,
    });
    this.workingSet.replaceRecentRoutes(projectId, plan.recentRoutes);
    state.selection = plan.selection;
    state.admitted = plan.admitted;
    state.removalFence = plan.removalFence;
    state.transitionRevision = plan.transitionRevision;
    const leaving = documentIds.filter((id) => !held.has(id));
    this.forget(projectId, leaving);
    if (leaving.length > 0) this.addresses?.removed(projectId, leaving);
    this.notices?.presentedRemoved(
      projectId,
      documentIds.flatMap((id) => {
        const tab = presented.find(
          (candidate) => candidate.kind !== "new" && candidate.documentId === id,
        );
        return tab && !plan.tabs.some((candidate) => candidate.documentId === id) ? [tab] : [];
      }),
    );
    this.publish(state);
  }

  /**
   * These documents' local copies can no longer come back to this account (their nodes were
   * purged): each session closes and its copy is deleted.
   */
  clearLocalCopies(documentIds: readonly string[]): Promise<unknown> {
    return Promise.all(documentIds.map((id) => this.copies?.clearLocalCopy(id as never)));
  }

  /**
   * The writer closed a document a view presents (a draft-only page has no Live to return to).
   * Closing main's document takes main's address to the empty Editor; nothing is chosen in its
   * place.
   */
  writerClose(
    projectId: string,
    addressed: OpenDocument,
  ): ContextRemovalOutcome | Promise<NavigationSettlement> {
    if (this.unavailable()) return { kind: "noop" };
    const state = this.project(projectId);
    const documentId = addressed.documentId;
    this.presented.forget(projectId, [documentId]);
    const presented = this.presented.documents(projectId);
    const tab = presented.find((candidate) => candidate.documentId === documentId);
    if (!tab) {
      this.tabs?.close(projectId, [documentId]);
      return { kind: "noop" };
    }
    const route = this.routePorts.get(projectId)?.port ?? this.fallbackRoute;
    const transition = reduceRepresentedRemoval(state.selection, [tab], {
      cause: "writer-close",
      documentIds: [documentId],
    });
    const plan = planContextRemoval({
      activeWorkId: state.activeWorkId,
      tabs: presented,
      selectedTabId: state.activeWorkId ? this.presented.mainDocumentId(projectId) : null,
      admitted: state.admitted,
      route: { cleanup: transition.planning.cleanup, current: transition.planning.current },
      intent: transition.planning.intent,
    });
    const closesShownDocument =
      plan.outcome.kind === "removal" &&
      (plan.outcome.workspaceSelectedRemoved || plan.outcome.routedDocumentRemoved);
    if (!closesShownDocument || !route?.readSearch(projectId).scheme)
      return this.commitWriterClose(projectId, tab);
    const capturedSelection = state.selection;
    const capturedWork = state.activeWorkId;
    return route.transition(
      projectId,
      { kind: "clear" },
      {
        isCurrent: () =>
          !this.unavailable() &&
          this.presented.documents(projectId).some((member) => member.documentId === documentId) &&
          state.selection === capturedSelection &&
          state.activeWorkId === capturedWork,
        commit: () => {
          this.commitWriterClose(projectId, tab);
        },
      },
    );
  }

  private commitWriterClose(projectId: string, addressed: OpenDocument): ContextRemovalOutcome {
    if (this.unavailable()) return { kind: "noop" };
    const documentId = addressed.documentId;
    const tab = this.presented
      .documents(projectId)
      .find((candidate) => candidate.documentId === documentId);
    if (!tab) return { kind: "noop" };
    const state = this.project(projectId);
    const transition = reduceRepresentedRemoval(state.selection, [tab], {
      cause: "writer-close",
      documentIds: [documentId],
    });
    state.selection = transition.selection;
    const outcome = this.executePlanning(projectId, transition.planning);
    this.publish(state);
    // After main's address has left the document, so its tab is not drawn again meanwhile.
    this.tabs?.close(projectId, [documentId]);
    return outcome;
  }

  /**
   * The writer is deleting or Discarding these documents: their removal says nothing, and main,
   * if it shows one of them, goes at once to the document it showed before, else to Recently
   * opened. Call before the removal. `landed`
   * hears where main went, or null when it did not move; nothing when main did not show them.
   */
  beginOwnRemoval(
    projectId: string,
    documentIds: readonly string[],
    landed?: (landing: MainLanding | null) => void,
  ): void {
    const shown = this.presented.mainDocumentId(projectId);
    const route = this.routePorts.get(projectId)?.port ?? this.fallbackRoute;
    if (this.unavailable() || !route || !shown || !documentIds.includes(shown)) return;
    const goingBack = this.project(projectId).goingBack;
    goingBack.add(shown);
    void route
      .goBack(
        projectId,
        shown,
        documentIds,
        () => !this.unavailable() && this.presented.mainDocumentId(projectId) === shown,
      )
      .finally(() => goingBack.delete(shown))
      .then((landing) => landed?.(landing));
  }

  /**
   * The catalog no longer places a mounted document. A presented one's notice says why once
   * the list shows a removal; the address stays where it is, so the view shows the removal
   * in place. A kept one, off screen, just goes.
   */
  closeVanished(projectId: string, tab: OpenDocument): ContextRemovalOutcome {
    if (this.unavailable()) return { kind: "noop" };
    if (this.heldByDrafts(projectId, [tab.documentId]).has(tab.documentId)) return { kind: "noop" };
    this.forget(projectId, [tab.documentId]);
    if (!this.presented.documents(projectId).some((shown) => shown.documentId === tab.documentId))
      return { kind: "noop" };
    this.notices?.presentedRemoved(projectId, [tab]);
    return this.commitWriterClose(projectId, tab);
  }

  /** The Work scope changed. The route's selection stays: a document's owner is its own. */
  setActiveWork(projectId: string, activeWorkId: string): void {
    if (this.unavailable()) return;
    const state = this.project(projectId);
    if (state.activeWorkId === activeWorkId) return;
    state.activeWorkId = activeWorkId;
    this.publish(state);
  }

  /**
   * A draft-created document a view presents lost its draft (a Discard). Runs when Discard starts
   * (optimistic) and again on server confirmation or a remote discard, where it finds nothing left
   * to remove. A refused Discard does not come back here: the error lives on the draft. A
   * document the writer's own removal is still sending main back from is left to that go-back.
   */
  discardDraft(projectId: string, documentId: string): ContextRemovalOutcome {
    if (this.unavailable() || this.projects.get(projectId)?.goingBack.has(documentId))
      return { kind: "noop" };
    this.forget(projectId, [documentId]);
    const tab = this.presented
      .documents(projectId)
      .find((candidate) => candidate.documentId === documentId);
    if (tab === undefined || tab.kind !== "tracked") return { kind: "noop" };
    const state = this.project(projectId);
    const transition = reduceRepresentedRemoval(state.selection, [tab], {
      cause: "draft-discard",
      documentIds: [tab.documentId],
    });
    state.selection = transition.selection;
    const outcome = this.executePlanning(projectId, transition.planning);
    this.publish(state);
    return outcome;
  }

  /**
   * An explicit Review launch re-admits a pending draft. A refused Discard
   * leaves its draft pending, so the removal guard that keeps Back and late
   * address resolution from resurrecting a discarded address no longer applies.
   */
  admitDraftReview(projectId: string, tab: Extract<OpenDocument, { kind: "tracked" }>): void {
    this.projects.get(projectId)?.terminalRemovals.delete(locatorKey(routeTargetForTab(tab)));
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

  private executePlanning(
    projectId: string,
    effect: RemovalPlanningEffect,
    additionalRemovedLocators: readonly WorkingSetRoute[] = [],
  ): ContextRemovalOutcome {
    const { intent, current, cleanup } = effect;
    if (intent.documentIds.length === 0) return { kind: "noop" };
    const state = this.project(projectId);
    const plan = planContextRemoval({
      activeWorkId: state.activeWorkId,
      tabs: this.presented.documents(projectId),
      selectedTabId: state.activeWorkId ? this.presented.mainDocumentId(projectId) : null,
      admitted: state.admitted,
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

    return plan.outcome;
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
    if (!state.activeWorkId) return;
    const plan = planCandidateRejection({
      rejected: rejection.locator,
      tabs: this.presented.documents(projectId),
      admitted: state.admitted,
      recentRoutes: this.workingSet.readRecentRoutes(projectId),
    });
    this.workingSet.reconcileContextRoutes(projectId, plan.workingSet);
    state.transitionRevision += 1;
    state.admitted = plan.admitted;
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
        activeWorkId: null,
        selection: { status: "none", revision: 0 },
        admitted: null,
        removalFence: null,
        transitionRevision: 0,
        terminalRemovals: new Map(),
        goingBack: new Set(),
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

function locatorKey(locator: ContextRouteRequest): string {
  return `${locator.scheme}\u0000${locator.path}\u0000${locator.workId ?? ""}\u0000${locator.rootThreadId ?? ""}`;
}
