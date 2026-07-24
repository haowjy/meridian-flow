/**
 * Stateful runtime for exercising untitled materialization and identity moves.
 *
 * The rig owns storage, scheduling, sessions, API outcomes, and callback
 * journals. Tests configure boundary outcomes, advance the scheduler, and
 * query reconciliation state rather than coordinating independent mocks.
 */

import type {
  CreateUntitledContextDocumentResponse,
  CreateUntitledContextDocumentResult,
  MoveContextEntryResult,
  MoveContextEntrySuccess,
} from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import * as Y from "yjs";
import type { moveContextEntry } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { type ContextTab, useContextTabsStore } from "@/client/stores";
import type { DocumentSessionSnapshot } from "@/core/editor/document-session";
import { createContextIdentityMutationService } from "../context-identity-mutation";
import type { DesiredIdentity } from "../identity-location";
import {
  type PendingUntitled,
  type ReconciliationRecord,
  UntitledReconciler,
  type UntitledReconcilerDeps,
} from "../untitled-reconciler";

export const UNTITLED_HOME = { scheme: "scratch", workId: "work-1" } as const;
export const UNTITLED_TAB: ContextTab = {
  kind: "tracked",
  documentId: "doc-1",
  scheme: "scratch",
  path: "/Untitled.md",
  name: "Untitled.md",
  workId: "work-1",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
  provisionalName: true,
};

type AsyncHandler<Args extends unknown[], Result> = (...args: Args) => Promise<Result>;

class OutcomePlan<Args extends unknown[], Result> {
  readonly calls: Args[] = [];
  private readonly handlers: Array<AsyncHandler<Args, Result>> = [];

  constructor(private fallback: AsyncHandler<Args, Result>) {}

  enqueueResult(...results: Result[]): void {
    for (const result of results) this.handlers.push(async () => result);
  }

  enqueueError(...errors: unknown[]): void {
    for (const error of errors) {
      this.handlers.push(async () => {
        throw error;
      });
    }
  }

  enqueueHandler(handler: AsyncHandler<Args, Result>): void {
    this.handlers.push(handler);
  }

  setFallback(handler: AsyncHandler<Args, Result>): void {
    this.fallback = handler;
  }

  run = async (...args: Args): Promise<Result> => {
    this.calls.push(args);
    return (this.handlers.shift() ?? this.fallback)(...args);
  };
}

export type LifecycleGate<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
};

export function lifecycleGate<T>(): LifecycleGate<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

export function documentWithText(text = "words"): Y.Doc {
  const document = new Y.Doc();
  if (text) {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText(text)]);
    document.getXmlFragment("prosemirror").insert(0, [paragraph]);
  }
  return document;
}

export class LifecycleSession {
  readonly document: Y.Doc;
  readonly fragmentName = "prosemirror" as const;
  localSyncCount = 0;
  durableSyncCount = 0;
  persistenceFlushCount = 0;

  private status: DocumentSessionSnapshot["status"] = "synced";
  private localSync = async () => {};
  private durableSync = async () => {};
  private persistenceFlush = async () => {};

  constructor(document = documentWithText()) {
    this.document = document;
  }

  getSnapshot = (): DocumentSessionSnapshot => ({ status: this.status }) as DocumentSessionSnapshot;

  whenLocalPersistenceSynced = async (): Promise<void> => {
    this.localSyncCount += 1;
    await this.localSync();
  };

  waitForDurableSync = async (): Promise<void> => {
    this.durableSyncCount += 1;
    await this.durableSync();
  };

  flushLocalPersistence = async (): Promise<void> => {
    this.persistenceFlushCount += 1;
    await this.persistenceFlush();
  };

  setStatus(status: DocumentSessionSnapshot["status"]): void {
    this.status = status;
  }

  waitForLocalSync(gate: LifecycleGate<void>): void {
    this.localSync = () => gate.promise;
  }

  waitForDurable(gate: LifecycleGate<void>): void {
    this.durableSync = () => gate.promise;
  }

  waitForPersistenceFlush(gate: LifecycleGate<void>): void {
    this.persistenceFlush = () => gate.promise;
  }
}

type ResolvedEntry = PendingUntitled & { home: typeof UNTITLED_HOME };
type MoveSource = CreateUntitledContextDocumentResponse;

export class UntitledLifecycleRig {
  readonly queryClient = new QueryClient();
  readonly storage = new Map<string, string>();
  readonly queued: Array<() => void> = [];
  readonly timers: Array<() => void> = [];
  readonly onlineListeners = new Set<() => void>();
  readonly sessions = new Map<string, LifecycleSession>();
  readonly clearedRooms: string[] = [];
  readonly restartedRooms: string[] = [];
  readonly materialized: CreateUntitledContextDocumentResponse[] = [];
  readonly identities: MoveContextEntrySuccess[] = [];
  readonly reminted: string[] = [];

  readonly home = new OutcomePlan<[string], typeof UNTITLED_HOME | null>(async () => UNTITLED_HOME);
  readonly create = new OutcomePlan<[ResolvedEntry], CreateUntitledContextDocumentResult>(
    async (entry) => ({
      status: "created",
      documentId: entry.documentId,
      scheme: "scratch",
      path: "/Untitled",
      name: "Untitled",
    }),
  );
  readonly exists = new OutcomePlan<[ResolvedEntry], boolean>(async () => false);
  readonly move = new OutcomePlan<
    [ResolvedEntry, MoveSource, DesiredIdentity],
    MoveContextEntryResult
  >(async () => ({
    status: "moved",
    scheme: "manuscript",
    path: "Act 1/Opening.md",
    name: "Opening.md",
  }));
  readonly identityMove = new OutcomePlan<
    Parameters<typeof moveContextEntry>,
    Awaited<ReturnType<typeof moveContextEntry>>
  >(async () => ({
    status: "moved",
    scheme: "manuscript",
    path: "Act 1/Opening.md",
    name: "Opening.md",
  }));
  readonly identityMutations = createContextIdentityMutationService(
    this.queryClient,
    this.identityMove.run,
  );

  readonly deps: UntitledReconcilerDeps;
  reconciler: UntitledReconciler;
  nextDocumentId = "replacement";
  destroyRoomError: Error | null = null;

  constructor() {
    this.deps = {
      storage: {
        getItem: (key) => this.storage.get(key) ?? null,
        setItem: (key, value) => this.storage.set(key, value),
      },
      scheduler: {
        queue: (task) => this.queued.push(task),
        setTimer: (task) => {
          this.timers.push(task);
          return task;
        },
        clearTimer: (timer) => {
          const index = this.timers.indexOf(timer as () => void);
          if (index >= 0) this.timers.splice(index, 1);
        },
        onOnline: (task) => {
          this.onlineListeners.add(task);
          return () => this.onlineListeners.delete(task);
        },
      },
      api: {
        resolveHome: this.home.run,
        create: this.create.run,
        serverDocumentExists: this.exists.run,
        move: this.move.run,
      },
      sessions: {
        getDetached: (documentId) => this.session(documentId),
        attachDetached: (documentId) => {
          const session = this.sessions.get(documentId);
          if (!session) throw new Error(`missing session ${documentId}`);
          if (session.getSnapshot().status === "detached") session.setStatus("synced");
          return session;
        },
        restartUnavailableRoom: async (documentId) => {
          this.restartedRooms.push(documentId);
          const session = this.sessions.get(documentId);
          if (session?.getSnapshot().status !== "access-lost") return false;
          session.setStatus("detached");
          return true;
        },
        retain: () => {},
        release: () => {},
        destroyRoom: async (documentId, options) => {
          if (this.destroyRoomError) throw this.destroyRoomError;
          if (options?.clearPersistence) this.clearedRooms.push(documentId);
          this.sessions.delete(documentId);
        },
      },
      newDocumentId: () => this.nextDocumentId,
    };
    this.reconciler = new UntitledReconciler(this.deps);
  }

  seedTab(tab: ContextTab = UNTITLED_TAB, projectId = "project-1"): ContextTab {
    useContextTabsStore.setState({
      byProject: { [projectId]: { tabs: [tab], activeTabId: tab.documentId } },
    });
    return tab;
  }

  seedTree(projectId: string, scheme: "manuscript" | "scratch", workId?: string): void {
    this.queryClient.setQueryData(projectQueryKeys.contextTree(projectId, scheme, workId), {});
  }

  treeInvalidated(projectId: string, scheme: "manuscript" | "scratch", workId?: string): boolean {
    return Boolean(
      this.queryClient.getQueryState(projectQueryKeys.contextTree(projectId, scheme, workId))
        ?.isInvalidated,
    );
  }

  session(documentId: string, text = "words"): LifecycleSession {
    let session = this.sessions.get(documentId);
    if (!session) {
      session = new LifecycleSession(documentWithText(text));
      this.sessions.set(documentId, session);
    }
    return session;
  }

  replaceSession(documentId: string, session: LifecycleSession): void {
    this.sessions.set(documentId, session);
  }

  start(): void {
    this.reconciler.start();
  }

  restart(): void {
    this.reconciler.dispose();
    this.reconciler = new UntitledReconciler(this.deps);
    this.reconciler.start();
  }

  trackCandidate(documentId: string): void {
    this.reconciler.registerCandidate(documentId, {
      onReminted: (id) => this.reminted.push(id),
      onMaterialized: (result) => this.materialized.push(result),
      onIdentityCommitted: (result) => this.identities.push(result),
    });
  }

  append(documentId: string, options: { projectId?: string; withHome?: boolean } = {}): void {
    this.reconciler.append({
      documentId,
      projectId: options.projectId ?? "project-1",
      ...(options.withHome === false ? {} : { home: UNTITLED_HOME }),
    });
  }

  queueIdentity(documentId: string, name: string, folderPath = "Act 1"): void {
    this.reconciler.queueIdentity(
      { documentId, projectId: "project-1", home: UNTITLED_HOME },
      { name, destination: { scheme: "manuscript", folderPath } },
    );
  }

  async advance(): Promise<void> {
    this.queued.shift()?.();
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  }

  async retry(): Promise<void> {
    this.timers.shift()?.();
    await this.advance();
  }

  notifyOnline(): void {
    for (const listener of this.onlineListeners) listener();
  }

  records(): ReconciliationRecord[] {
    return JSON.parse(
      this.storage.get("meridian:pending-untitled") ?? "[]",
    ) as ReconciliationRecord[];
  }
}
