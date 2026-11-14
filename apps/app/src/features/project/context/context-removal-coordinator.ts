/**
 * What a document's removal does around the route: its views are forgotten, a notice is told, its
 * recent routes are dropped. Where main goes is the route's (`ReadableProjectRoute`), which reads
 * the replay; nothing here plans or remembers a route.
 */

import type { ProjectContextTreeScheme, WorkingSetRoute } from "@meridian/contracts/protocol";
import { readAccountRecents } from "@/client/recents";
import type { OpenDocument } from "@/client/stores";
import {
  buildWorkingSetRoute,
  type ReconcileContextRoutesInput,
  readRecentRoutes,
  reconcileContextRoutes,
  replaceRecentRoutes,
} from "@/client/working-set";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import type {
  NavigationSettlement,
  PreparedWorkspaceNavigation,
} from "../routing/project-navigation";
import type { ContextRouteRequest } from "../routing/project-route";
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
 * What the views present (`PresentedDocuments`). A close, a Discard or a removal forgets the
 * document, so no view picks it again and its host unmounts.
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

/** Where views report documents they presented that vanished (`RemovedNoticeStore`). */
export type RemovedPresentationPort = Pick<
  RemovedNoticeStore,
  "presentedRemoved" | "markOwnRemoval"
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

/** The views a removal took from main or the side. */
export type ContextRemovalOutcome =
  | { kind: "noop" }
  | { kind: "removal"; removed: readonly OpenDocument[] };

export type ContextRemovalLifetimeLease = {
  suspend(): void;
  resume(): void;
  disposeIfSuspended(): boolean;
};

const productionWorkingSet: ContextRemovalWorkingSetPort = {
  readRecentRoutes,
  reconcileContextRoutes,
  replaceRecentRoutes,
};

/** A route names a document the server holds: a local-only document's route waits for its materialization. */
function workingSetRouteForTab(tab: OpenDocument): WorkingSetRoute | null {
  if (tab.kind === "new" || (tab.kind === "tracked" && tab.localOnly)) return null;
  return buildWorkingSetRoute(tab.documentId, tab.scheme, tab.path, tab);
}

export class ContextRemovalCoordinator {
  private readonly routePorts = new Map<string, { token: symbol; port: ContextRemovalRoutePort }>();
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
  /** Documents whose own removal is still sending main back: their draft's end closes nothing. */
  private readonly goingBack = new Set<string>();
  private disposed = false;
  private suspended = false;

  constructor(
    dependencies: {
      presented?: PresentedPort;
      workingSet?: ContextRemovalWorkingSetPort;
      copies?: Pick<LiveDocumentSessionRegistry, "clearLocalCopy">;
      notices?: RemovedPresentationPort;
      drafts?: BoundDraftsPort;
      draftOnly?: DraftOnlyPort;
      addresses?: AddressAnswersPort;
      tabs?: ClosedTabsPort;
    } = {},
  ) {
    this.presented = dependencies.presented ?? new PresentedDocuments();
    this.workingSet = dependencies.workingSet ?? productionWorkingSet;
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

  registerRoutePort(
    projectId: string,
    port: ContextRemovalRoutePort,
  ): { token: symbol; release: () => void } {
    if (this.unavailable()) return { token: Symbol(projectId), release: () => undefined };
    const token = Symbol(projectId);
    this.routePorts.set(projectId, { token, port });
    return {
      token,
      release: () => {
        if (this.routePorts.get(projectId)?.token === token) this.routePorts.delete(projectId);
      },
    };
  }

  /**
   * Main shows `documentId` live at `locator`: it is the project's most recent route, and the
   * routes of the documents views present repair their locators with it.
   */
  recordRoute(projectId: string, documentId: string, locator: ContextRouteRequest): void {
    if (this.unavailable() || this.gone.has(`${projectId}/${documentId}`)) return;
    const route = buildWorkingSetRoute(documentId, locator.scheme, locator.path, locator);
    if (!route) return;
    this.workingSet.reconcileContextRoutes(projectId, {
      removedLocators: [],
      survivingOwnedLocators: [
        ...this.presented.documents(projectId).flatMap((tab) => workingSetRouteForTab(tab) ?? []),
        route,
      ],
      promote: route,
      clearAll: false,
    });
  }

  /** The documents of the project a removal can touch: the ones views present and recent routes name. */
  watchedDocumentIds(projectId: string): string[] {
    const ids = new Set(this.presented.documents(projectId).map((tab) => tab.documentId));
    for (const route of this.workingSet.readRecentRoutes(projectId))
      if (route.documentId) ids.add(route.documentId);
    for (const item of readAccountRecents(projectId))
      if (item.address.kind === "document") ids.add(item.documentId);
    return [...ids];
  }

  /**
   * The document main shows, when it is among `documentIds` and this tab is not already taking
   * main off it (the writer's own removal goes back by itself).
   */
  shownAmong(projectId: string, documentIds: readonly string[]): string | null {
    const shown = this.presented.mainDocumentId(projectId);
    return shown && documentIds.includes(shown) && !this.goingBack.has(`${projectId}/${shown}`)
      ? shown
      : null;
  }

  /** What the list says changed, as one batch. A document already gone stays gone: the batch repeats nothing. */
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
    const held = this.heldByDrafts(projectId, documentIds);
    const presented = this.presented.documents(projectId);
    this.dropRecentRoutes(projectId, documentIds);
    const leaving = documentIds.filter((id) => !held.has(id));
    this.forget(projectId, leaving);
    if (leaving.length > 0) this.addresses?.removed(projectId, leaving);
    this.notices?.presentedRemoved(
      projectId,
      presented.filter((tab) => tab.kind !== "new" && leaving.includes(tab.documentId)),
    );
  }

  private dropRecentRoutes(projectId: string, documentIds: readonly string[]): void {
    const routes = this.workingSet.readRecentRoutes(projectId);
    if (routes.some((route) => documentIds.includes(route.documentId)))
      this.workingSet.replaceRecentRoutes(
        projectId,
        routes.filter((route) => !documentIds.includes(route.documentId)),
      );
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
  writerClose(projectId: string, addressed: OpenDocument): void {
    if (this.unavailable()) return;
    const documentId = addressed.documentId;
    this.presented.forget(projectId, [documentId]);
    const finish = () => {
      this.dropRecentRoutes(projectId, [documentId]);
      // After main's address has left the document, so its tab is not drawn again meanwhile.
      this.tabs?.close(projectId, [documentId]);
    };
    const route = this.routePorts.get(projectId)?.port;
    if (!route || this.presented.mainDocumentId(projectId) !== documentId) {
      finish();
      return;
    }
    void route
      .transition(
        projectId,
        { kind: "clear" },
        {
          isCurrent: () =>
            !this.unavailable() && this.presented.mainDocumentId(projectId) === documentId,
          commit: finish,
        },
      )
      .then(
        (settlement) => {
          if (settlement.kind === "failed") reportError(settlement.error);
        },
        (error: unknown) => reportError(error),
      );
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
    this.notices?.markOwnRemoval(projectId, documentIds);
    const shown = this.presented.mainDocumentId(projectId);
    const route = this.routePorts.get(projectId)?.port;
    if (this.unavailable() || !route || !shown || !documentIds.includes(shown)) return;
    const key = `${projectId}/${shown}`;
    this.goingBack.add(key);
    void route
      .goBack(
        projectId,
        shown,
        documentIds,
        () => !this.unavailable() && this.presented.mainDocumentId(projectId) === shown,
      )
      .finally(() => this.goingBack.delete(key))
      .then((landing) => landed?.(landing));
  }

  /**
   * A draft-created document a view presents lost its draft (a Discard). Runs when Discard starts
   * (optimistic) and again on server confirmation or a remote discard, where it finds nothing left
   * to remove. A refused Discard does not come back here: the error lives on the draft. A
   * document the writer's own removal is still sending main back from is left to that go-back.
   */
  discardDraft(projectId: string, documentId: string): ContextRemovalOutcome {
    if (this.unavailable() || this.goingBack.has(`${projectId}/${documentId}`))
      return { kind: "noop" };
    this.forget(projectId, [documentId]);
    const tab = this.presented
      .documents(projectId)
      .find((candidate) => candidate.documentId === documentId);
    if (tab === undefined || tab.kind !== "tracked") return { kind: "noop" };
    this.dropRecentRoutes(projectId, [documentId]);
    return { kind: "removal", removed: [tab] };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.routePorts.clear();
  }
}
