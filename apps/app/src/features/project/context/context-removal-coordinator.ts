import { readAccountRecents } from "@/client/recents";
import type { OpenDocument } from "@/client/stores";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import type {
  NavigationSettlement,
  PreparedWorkspaceNavigation,
} from "../routing/project-navigation";
import type { ContextRouteRequest } from "../routing/project-route";
import { PresentedDocuments } from "./presented-documents";

export type MainLanding = { documentId: string | null };

export type ContextRemovalRoutePort = {
  transition(
    projectId: string,
    target: ContextRouteRequest | { kind: "clear" },
    prepared: PreparedWorkspaceNavigation,
  ): Promise<NavigationSettlement>;
  goBack(
    projectId: string,
    documentId: string,
    removing: readonly string[],
    isCurrent: () => boolean,
  ): Promise<MainLanding | null>;
};

type PresentedPort = Pick<PresentedDocuments, "documents" | "mainDocumentId" | "forget">;

export type ClosedTabsPort = {
  close(projectId: string, documentIds: readonly string[]): void;
};

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
  private readonly gone = new Set<string>();
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

  private forget(projectId: string, documentIds: readonly string[]): void {
    this.presented.forget(projectId, documentIds);
    this.tabs?.close(projectId, documentIds);
  }

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

  watchedDocumentIds(projectId: string): string[] {
    const ids = new Set(this.presented.documents(projectId).map((tab) => tab.documentId));
    for (const item of readAccountRecents(projectId))
      if (item.address.kind === "document") ids.add(item.documentId);
    return [...ids];
  }

  isGoingBack(projectId: string, documentId: string): boolean {
    return this.goingBack.has(`${projectId}/${documentId}`);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

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

  reconcileInstalledTab(projectId: string, tab: OpenDocument): void {
    if (tab.kind === "new" || !this.gone.has(`${projectId}/${tab.documentId}`)) return;
    this.applyGone(projectId, [tab.documentId]);
  }

  private applyGone(projectId: string, documentIds: readonly string[]): void {
    for (const documentId of documentIds) this.gone.add(`${projectId}/${documentId}`);
    this.forget(projectId, documentIds);
  }

  clearLocalCopies(documentIds: readonly string[]): Promise<unknown> {
    return Promise.all(documentIds.map((id) => this.copies?.clearLocalCopy(id as never)));
  }

  leaveDraftOnly(
    projectId: string,
    documentId: string,
    landed?: (landing: MainLanding | null) => void,
  ): void {
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
