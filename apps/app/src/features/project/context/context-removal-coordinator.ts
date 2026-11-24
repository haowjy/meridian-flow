/**
 * What a document's removal does around the route: its views are forgotten and a notice is told. Where main goes is the route's (`ReadableProjectRoute`), which reads
 * the document's standing; nothing here navigates main for a removal made elsewhere.
 */

import { readAccountRecents } from "@/client/recents";
import type { OpenDocument } from "@/client/stores";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import type {
  NavigationSettlement,
  PreparedWorkspaceNavigation,
} from "../routing/project-navigation";
import type { ContextRouteRequest } from "../routing/project-route";
import { PresentedDocuments } from "./presented-documents";

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

export class ContextRemovalCoordinator {
  private readonly routePorts = new Map<string, { token: symbol; port: ContextRemovalRoutePort }>();
  private readonly presented: PresentedPort;
  private readonly copies: Pick<LiveDocumentSessionRegistry, "clearLocalCopy"> | null;
  private readonly tabs: ClosedTabsPort | null;
  /** The documents the list has taken out of the live tree and has not given back, by `projectId/documentId`. */
  private readonly gone = new Set<string>();
  /** Documents whose own removal is still sending main back: their draft's end closes nothing. */
  private readonly goingBack = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  private suspended = false;

  constructor(
    dependencies: {
      presented?: PresentedPort;
      copies?: Pick<LiveDocumentSessionRegistry, "clearLocalCopy">;
      tabs?: ClosedTabsPort;
    } = {},
  ) {
    this.presented = dependencies.presented ?? new PresentedDocuments();
    this.copies = dependencies.copies ?? null;
    this.tabs = dependencies.tabs ?? null;
  }

  /** These documents are closed, Discarded or removed: no view picks them again and their tabs close. */
  private forget(projectId: string, documentIds: readonly string[]): void {
    this.presented.forget(projectId, documentIds);
    this.tabs?.close(projectId, documentIds);
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

  /** The documents of the project a removal can touch: the ones views present and account recents name. */
  watchedDocumentIds(projectId: string): string[] {
    const ids = new Set(this.presented.documents(projectId).map((tab) => tab.documentId));
    for (const item of readAccountRecents(projectId))
      if (item.address.kind === "document") ids.add(item.documentId);
    return [...ids];
  }

  /** Whether the writer's own removal of this document is still sending main back from it. */
  isGoingBack(projectId: string, documentId: string): boolean {
    return this.goingBack.has(`${projectId}/${documentId}`);
  }

  /** Called when `isGoingBack` may have changed: the route holds its Trash view back meanwhile. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** What the list says changed, as one batch. A document already gone stays gone: the batch repeats nothing. */
  applyRemovals(commands: readonly RemovalCommand[]): void {
    if (this.unavailable()) return;
    for (const projectId of new Set(commands.map((command) => command.projectId))) {
      const mine = commands.filter((command) => command.projectId === projectId);
      const key = (command: RemovalCommand) => `${projectId}/${command.documentId}`;
      const removed = mine.filter(
        (command) => command.kind === "gone" && !this.gone.has(key(command)),
      );
      for (const command of mine) if (command.kind === "back") this.gone.delete(key(command));
      if (removed.length > 0)
        this.applyGone(
          projectId,
          removed.map((command) => command.documentId),
        );
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
    this.forget(projectId, documentIds);
  }

  /**
   * These documents' local copies can no longer come back to this account (their nodes were
   * purged): each session closes and its copy is deleted.
   */
  clearLocalCopies(documentIds: readonly string[]): Promise<unknown> {
    return Promise.all(documentIds.map((id) => this.copies?.clearLocalCopy(id as never)));
  }

  /**
   * The writer switched a page only a draft holds to Live, which lacks it: it closes
   * as a Discarded one does, main going back to the document it showed before, else to Recently
   * opened, and its tab closes once main has left it. `landed` hears where main went, as with
   * `beginOwnRemoval`. Nothing happens when main doesn't show it; `isGoingBack` says whether main
   * is leaving.
   */
  leaveDraftOnly(
    projectId: string,
    documentId: string,
    landed?: (landing: MainLanding | null) => void,
  ): void {
    // The pin's follow asks again on each render until main has left.
    if (this.unavailable() || this.isGoingBack(projectId, documentId)) return;
    this.beginOwnRemoval(projectId, [documentId], (landing) => {
      this.forget(projectId, [documentId]);
      landed?.(landing);
    });
  }

  /**
   * The writer is deleting or Discarding these documents: main,
   * if it shows one of them, goes at once to the document it showed before, else to Recently
   * opened. Call before the removal. `landed`
   * hears where main went, or null when it did not move; nothing when main did not show them.
   * Returns the document main is leaving, if it shows one of them.
   */
  beginOwnRemoval(
    projectId: string,
    documentIds: readonly string[],
    landed?: (landing: MainLanding | null) => void,
  ): string | null {
    const shown = this.presented.mainDocumentId(projectId);
    const route = this.routePorts.get(projectId)?.port;
    if (this.unavailable() || !route || !shown || !documentIds.includes(shown)) return null;
    const key = `${projectId}/${shown}`;
    this.goingBack.add(key);
    void route
      .goBack(
        projectId,
        shown,
        documentIds,
        () => !this.unavailable() && this.presented.mainDocumentId(projectId) === shown,
      )
      .finally(() => {
        this.goingBack.delete(key);
        for (const listener of [...this.listeners]) listener();
      })
      .then((landing) => landed?.(landing));
    return shown;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.routePorts.clear();
  }
}
