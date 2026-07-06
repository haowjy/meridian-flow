// Owns per-session runtime Y.Doc lifecycles, live sync, and recovery flags.
import * as Y from "yjs";
import type { ActorSession } from "../ports/actor-session-store.js";
import {
  type DocumentCoordinator,
  isDocumentNotFoundError,
} from "../ports/document-coordinator.js";
import type { SyncStateStore } from "../ports/sync-state-store.js";
import { applyYjsUpdateIfEffective } from "../yjs-update.js";
import { withLiveDocument } from "./coordinator.js";
import {
  documentNotFound,
  type InternalWriteResult,
  isInternalWriteResult,
} from "./internal-result.js";
import type { WriteCommand } from "./types.js";

export interface RuntimeDocumentState {
  doc: Y.Doc;
  session: ActorSession;
  threadId: string;
}

interface SyncStateEpoch {
  document: number;
  key: number;
}

export interface RuntimeRecoveryDocument {
  docId: string;
  session: ActorSession;
  runtime: RuntimeDocumentState;
  commandName: WriteCommand["command"];
}

export interface RuntimeStore {
  runtimeFor(session: ActorSession, docId: string): RuntimeDocumentState;
  attachRuntime(session: ActorSession, docId: string, runtime: RuntimeDocumentState): void;
  evictRuntime(session: ActorSession, docId: string, options?: RuntimeEvictOptions): Promise<void>;
  evictResponseRuntimes(
    documents: readonly RuntimeRecoveryDocument[],
    options?: RuntimeEvictOptions,
  ): Promise<void>;
  evictThreadRuntimes(
    docId: string,
    threadId: string,
    options?: RuntimeEvictOptions,
  ): Promise<void>;
  restoreRuntimeFromLive(
    session: ActorSession,
    docId: string,
    runtime: RuntimeDocumentState,
    commandName: WriteCommand["command"],
    options?: RuntimeRestoreOptions,
  ): Promise<InternalWriteResult | null>;
  recoverCommittedResponseProjection(documents: readonly RuntimeRecoveryDocument[]): Promise<void>;
  syncLocalFromLive(
    session: ActorSession,
    docId: string,
    runtime: RuntimeDocumentState,
    commandName: WriteCommand["command"],
  ): Promise<{ ok: true } | { ok: false; response: InternalWriteResult }>;
  requireSynced(
    session: ActorSession,
    docId: string,
    commandName: WriteCommand["command"],
    filePath?: string,
    runtime?: RuntimeDocumentState,
    options?: RuntimeSyncOptions,
  ): Promise<{ ok: true; stateVector: Uint8Array } | { ok: false; response: InternalWriteResult }>;
  markSynced(session: ActorSession, docId: string, runtime: RuntimeDocumentState): void;
  setCommittedSnapshot(session: ActorSession, docId: string, snapshot: Uint8Array): void;
  getCommittedSnapshot(session: ActorSession, docId: string): Uint8Array | undefined;
  /** @internal test/diagnostic visibility for the durable sync-state queue. */
  syncStateWriteQueueSize(): number;
  /** Await all currently queued durable sync-state writes for this core. */
  drainSyncStateWrites(): Promise<void>;
}

export interface RuntimeEvictOptions {
  markLiveDocStale?: boolean;
  deleteSyncState?: boolean;
}

export interface RuntimeRestoreOptions {
  filePath?: string;
}

export interface RuntimeSyncOptions {
  rejectOnStale?: boolean;
}

export function createRuntimeStore(deps: {
  coordinator: DocumentCoordinator;
  createRuntimeDoc: () => Y.Doc;
  syncStateStore?: SyncStateStore;
}): RuntimeStore {
  const { coordinator, createRuntimeDoc } = deps;
  const runtimeDocs = new Map<string, RuntimeDocumentState>();
  // Live docs whose canonical journal has updates not yet replayed into the
  // shared in-memory live Y.Doc; the next access replays (coordinator.recover)
  // before trusting the doc, then clears the flag.
  //
  // Doc-scoped, NOT thread-scoped, on purpose: the live doc is shared canonical
  // state, so any thread that touches a stale live doc must replay first
  // (recover is idempotent). This is distinct from a missing runtime replica
  // (removed from runtimeDocs) — that needs no flag because a missing replica is
  // always lazily rebuilt from canonical.
  const staleLiveDocs = new Set<string>();
  const syncStateWrites = new Map<string, Promise<void>>();
  const syncStateKeyEpochs = new Map<string, number>();
  const syncStateDocumentEpochs = new Map<string, number>();
  const runtimeSyncEpochs = new Map<string, SyncStateEpoch>();

  return {
    runtimeFor,
    attachRuntime,
    evictRuntime,
    evictResponseRuntimes,
    evictThreadRuntimes,
    restoreRuntimeFromLive,
    recoverCommittedResponseProjection,
    syncLocalFromLive,
    requireSynced,
    markSynced,
    setCommittedSnapshot,
    getCommittedSnapshot,
    syncStateWriteQueueSize: () => syncStateWrites.size,
    drainSyncStateWrites,
  };

  function runtimeFor(session: ActorSession, docId: string): RuntimeDocumentState {
    const key = runtimeKey(session, docId);
    const existing = runtimeDocs.get(key);
    if (existing) return existing;
    const runtime: RuntimeDocumentState = {
      doc: createRuntimeDoc(),
      session,
      threadId: session.threadId,
    };
    runtimeDocs.set(key, runtime);
    runtimeSyncEpochs.set(key, currentSyncStateEpoch(docId, session.threadId));
    return runtime;
  }

  function attachRuntime(
    session: ActorSession,
    docId: string,
    runtime: RuntimeDocumentState,
  ): void {
    staleLiveDocs.delete(docId);
    runtimeDocs.set(runtimeKey(session, docId), runtime);
    runtimeSyncEpochs.set(
      runtimeKey(session, docId),
      currentSyncStateEpoch(docId, session.threadId),
    );
    const stateVector = Y.encodeStateVector(runtime.doc);
    // At commit, synced and committed snapshots are the same — both
    // represent the runtime state after the commit resolved.
    const snapshot = Y.encodeStateAsUpdate(runtime.doc);
    session.documents.set(docId, { stateVector, committedSnapshot: snapshot });
    persistSyncState(session, docId, stateVector, snapshot, snapshot);
  }

  async function evictResponseRuntimes(
    documents: readonly RuntimeRecoveryDocument[],
    options: RuntimeEvictOptions = {},
  ): Promise<void> {
    await Promise.all(
      documents.map((document) => evictRuntime(document.session, document.docId, options)),
    );
  }

  async function evictRuntime(
    session: ActorSession,
    docId: string,
    options: RuntimeEvictOptions = {},
  ): Promise<void> {
    const key = runtimeKey(session, docId);
    runtimeDocs.delete(key);
    runtimeSyncEpochs.delete(key);
    session.documents.delete(docId);
    if (options.markLiveDocStale) staleLiveDocs.add(docId);
    if (options.deleteSyncState !== false) await deleteSyncState(docId, session.threadId);
  }

  async function evictThreadRuntimes(
    docId: string,
    threadId: string,
    options: RuntimeEvictOptions = {},
  ): Promise<void> {
    if (options.deleteSyncState !== false) await deleteSyncState(docId, threadId);
    for (const [key, runtime] of [...runtimeDocs]) {
      if (threadId && runtime.threadId !== threadId) continue;
      const runtimeDocId = docIdFromRuntimeKey(key);
      if (docId && runtimeDocId !== docId) continue;
      runtimeDocs.delete(key);
      runtimeSyncEpochs.delete(key);
      runtime.session.documents.delete(runtimeDocId);
    }
    if (options.markLiveDocStale && docId) staleLiveDocs.add(docId);
  }

  async function restoreRuntimeFromLive(
    session: ActorSession,
    docId: string,
    runtime: RuntimeDocumentState,
    commandName: WriteCommand["command"],
    options: RuntimeRestoreOptions = {},
  ): Promise<InternalWriteResult | null> {
    const filePath = options.filePath ?? docId;
    if (staleLiveDocs.has(docId)) {
      const recovered = await recoverLiveDocFromJournal(docId, commandName, filePath);
      if (recovered) return recovered;
    }
    const response = await withLiveDocument(
      coordinator,
      docId,
      commandName,
      filePath,
      (liveDoc) => {
        const restored = createRuntimeDoc();
        Y.applyUpdate(restored, Y.encodeStateAsUpdate(liveDoc), { type: "system" });
        runtime.doc = restored;
        return null;
      },
    );
    if (isInternalWriteResult(response)) return response;
    markSynced(session, docId, runtime);
    return null;
  }

  async function recoverCommittedResponseProjection(
    documents: readonly RuntimeRecoveryDocument[],
  ): Promise<void> {
    await recoverLiveDocsFromJournal(documents);
    for (const document of documents) {
      const restored = await restoreRuntimeFromLive(
        document.session,
        document.docId,
        document.runtime,
        document.commandName,
      );
      if (isInternalWriteResult(restored)) throw new Error(restored.text);
      attachRuntime(document.session, document.docId, document.runtime);
    }
  }

  async function recoverLiveDocsFromJournal(
    documents: readonly RuntimeRecoveryDocument[],
  ): Promise<void> {
    const seen = new Set<string>();
    for (const document of documents) {
      if (seen.has(document.docId)) continue;
      seen.add(document.docId);
      await coordinator.recover(document.docId);
      staleLiveDocs.delete(document.docId);
    }
  }

  async function mergeLiveIntoRuntime(
    _session: ActorSession,
    docId: string,
    runtime: RuntimeDocumentState,
    commandName: WriteCommand["command"],
  ): Promise<{ ok: true } | { ok: false; response: InternalWriteResult }> {
    if (staleLiveDocs.has(docId)) {
      const recovered = await recoverLiveDocFromJournal(docId, commandName);
      if (recovered) return { ok: false, response: recovered };
    }
    const response = await withLiveDocument(
      coordinator,
      docId,
      commandName,
      docId,
      async (liveDoc) => {
        const update = Y.encodeStateAsUpdate(liveDoc, Y.encodeStateVector(runtime.doc));
        applyYjsUpdateIfEffective(runtime.doc, update, { type: "system" });
        return null;
      },
    );
    if (isInternalWriteResult(response)) return { ok: false, response };
    return { ok: true };
  }

  async function syncLocalFromLive(
    session: ActorSession,
    docId: string,
    runtime: RuntimeDocumentState,
    commandName: WriteCommand["command"],
  ): Promise<{ ok: true } | { ok: false; response: InternalWriteResult }> {
    const merged = await mergeLiveIntoRuntime(session, docId, runtime, commandName);
    if (!merged.ok) return merged;
    markSynced(session, docId, runtime);
    return { ok: true };
  }

  async function hydrateFromPersistedRestart(
    session: ActorSession,
    docId: string,
    runtime: RuntimeDocumentState,
    persisted: {
      stateVector: Uint8Array;
      syncedSnapshot: Uint8Array;
      committedSnapshot: Uint8Array;
    },
  ): Promise<{ ok: true; stateVector: Uint8Array } | { ok: false; response: InternalWriteResult }> {
    const restored = createRuntimeDoc();
    Y.applyUpdate(restored, persisted.syncedSnapshot, { type: "system" });
    runtime.doc = restored;
    runtimeDocs.set(runtimeKey(session, docId), runtime);
    runtimeSyncEpochs.set(
      runtimeKey(session, docId),
      currentSyncStateEpoch(docId, session.threadId),
    );

    const merged = await mergeLiveIntoRuntime(session, docId, runtime, "read");
    if (!merged.ok) return merged;

    const stateVector = Y.encodeStateVector(runtime.doc);
    const syncedSnapshot = Y.encodeStateAsUpdate(runtime.doc);
    session.documents.set(docId, {
      stateVector,
      committedSnapshot: persisted.committedSnapshot,
    });
    persistSyncState(session, docId, stateVector, syncedSnapshot, persisted.committedSnapshot);
    return { ok: true, stateVector };
  }

  async function requireSynced(
    session: ActorSession,
    docId: string,
    commandName: WriteCommand["command"],
    filePath = docId,
    runtime?: RuntimeDocumentState,
    options: RuntimeSyncOptions = {},
  ): Promise<{ ok: true; stateVector: Uint8Array } | { ok: false; response: InternalWriteResult }> {
    if (staleLiveDocs.has(docId) && runtime) {
      if (options.rejectOnStale) {
        return {
          ok: false,
          response: {
            status: "not_found",
            text: `status: not_found\n\nDocument changed since your last read; a whole-scope replace/delete with no \`find\` is unsafe against a moved target. Run write(command="read", file="${filePath}") and retry.`,
          },
        };
      }
      const restored = await restoreRuntimeFromLive(session, docId, runtime, commandName, {
        filePath,
      });
      if (isInternalWriteResult(restored)) return { ok: false, response: restored };
      return { ok: true, stateVector: Y.encodeStateVector(runtime.doc) };
    }

    const state = session.documents.get(docId);
    if (state) return { ok: true, stateVector: state.stateVector };

    const persisted = await deps.syncStateStore?.load(docId, session.threadId);
    if (persisted) {
      if (runtime) return hydrateFromPersistedRestart(session, docId, runtime, persisted);
      session.documents.set(docId, {
        stateVector: persisted.stateVector,
        committedSnapshot: persisted.committedSnapshot,
      });
      return { ok: true, stateVector: persisted.stateVector };
    }

    if (runtime) {
      const restored = await restoreRuntimeFromLive(session, docId, runtime, commandName, {
        filePath,
      });
      if (isInternalWriteResult(restored)) return { ok: false, response: restored };
      return { ok: true, stateVector: Y.encodeStateVector(runtime.doc) };
    }

    return {
      ok: false,
      response: {
        status: "not_found",
        text: `status: not_found\n\nNo synced snapshot for ${filePath}. Run write(command="read", file="${filePath}") to re-sync.`,
      },
    };
  }

  function markSynced(session: ActorSession, docId: string, runtime: RuntimeDocumentState): void {
    const existing = session.documents.get(docId);
    const stateVector = Y.encodeStateVector(runtime.doc);
    // Preserve the committed snapshot (detection baseline) — only attachRuntime advances it.
    // If no committed snapshot exists yet (first read), use current state as initial baseline.
    const committedSnapshot = existing?.committedSnapshot ?? Y.encodeStateAsUpdate(runtime.doc);
    const syncedSnapshot = Y.encodeStateAsUpdate(runtime.doc);
    session.documents.set(docId, { stateVector, committedSnapshot });
    persistSyncState(session, docId, stateVector, syncedSnapshot, committedSnapshot);
  }

  function setCommittedSnapshot(session: ActorSession, docId: string, snapshot: Uint8Array): void {
    const existing = session.documents.get(docId);
    if (!existing) return;
    session.documents.set(docId, { ...existing, committedSnapshot: snapshot });
  }

  function getCommittedSnapshot(session: ActorSession, docId: string): Uint8Array | undefined {
    return session.documents.get(docId)?.committedSnapshot;
  }

  function persistSyncState(
    session: ActorSession,
    docId: string,
    stateVector: Uint8Array,
    syncedSnapshot: Uint8Array,
    committedSnapshot: Uint8Array,
  ): void {
    // Best-effort persistence — FK violations (staged creates before the
    // document row exists) are expected and harmless; the state will be
    // persisted on the next successful save after commit creates the doc.
    const store = deps.syncStateStore;
    if (!store) return;
    const key = syncStateKey(docId, session.threadId);
    const runtimeDocKey = runtimeKey(session, docId);
    const runtimeEpoch = runtimeSyncEpochs.get(runtimeDocKey);
    enqueueSyncStateWrite(key, async () => {
      if (runtimeDocs.get(runtimeDocKey)?.session !== session) return;
      if (!session.documents.has(docId)) return;
      if (!sameSyncStateEpoch(runtimeEpoch, currentSyncStateEpoch(docId, session.threadId))) return;
      await store.save(docId, session.threadId, { stateVector, syncedSnapshot, committedSnapshot });
    }).catch(() => undefined);
  }

  async function deleteSyncState(docId: string, threadId: string): Promise<void> {
    const store = deps.syncStateStore;
    if (!store) return;
    if (!threadId) {
      if (!docId) {
        const docIds = docIdsForThread("");
        for (const documentId of docIds) bumpDocumentSyncStateEpoch(documentId);
        await Promise.all([...docIds].map((documentId) => store.deleteDocument(documentId)));
        return;
      }
      bumpDocumentSyncStateEpoch(docId);
      await Promise.all(
        [...syncStateWrites]
          .filter(([key]) => key.startsWith(`${docId}\u0000`))
          .map(([, write]) => write.catch(() => undefined)),
      );
      await store.deleteDocument(docId);
      return;
    }
    if (!docId) {
      await Promise.all(
        [...docIdsForThread(threadId)].map((documentId) => {
          bumpSyncStateKeyEpoch(documentId, threadId);
          return enqueueSyncStateWrite(syncStateKey(documentId, threadId), () =>
            store.delete(documentId, threadId),
          );
        }),
      );
      return;
    }
    bumpSyncStateKeyEpoch(docId, threadId);
    await enqueueSyncStateWrite(syncStateKey(docId, threadId), () => store.delete(docId, threadId));
  }

  async function drainSyncStateWrites(): Promise<void> {
    await Promise.all([...syncStateWrites.values()].map((write) => write.catch(() => undefined)));
  }

  function docIdsForThread(threadId: string): Set<string> {
    const docIds = new Set<string>();
    for (const [key, runtime] of runtimeDocs) {
      if (threadId && runtime.threadId !== threadId) continue;
      docIds.add(docIdFromRuntimeKey(key));
      for (const docId of runtime.session.documents.keys()) docIds.add(docId);
    }
    for (const key of syncStateWrites.keys()) {
      // Include queued writes for a settled row whose runtime has already been evicted.
      const separatorIndex = key.lastIndexOf("\u0000");
      if (separatorIndex < 0) continue;
      const queuedThreadId = key.slice(separatorIndex + 1);
      if (threadId && queuedThreadId !== threadId) continue;
      const docId = key.slice(0, separatorIndex);
      if (docId) docIds.add(docId);
    }
    return docIds;
  }

  function enqueueSyncStateWrite(key: string, task: () => Promise<void>): Promise<void> {
    const chained = (syncStateWrites.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(task);
    const stored = chained.finally(() => {
      if (syncStateWrites.get(key) === stored) syncStateWrites.delete(key);
    });
    syncStateWrites.set(key, stored);
    return chained;
  }

  function currentSyncStateEpoch(docId: string, threadId: string): SyncStateEpoch {
    return {
      document: syncStateDocumentEpochs.get(docId) ?? 0,
      key: syncStateKeyEpochs.get(syncStateKey(docId, threadId)) ?? 0,
    };
  }

  function bumpDocumentSyncStateEpoch(docId: string): void {
    syncStateDocumentEpochs.set(docId, (syncStateDocumentEpochs.get(docId) ?? 0) + 1);
  }

  function bumpSyncStateKeyEpoch(docId: string, threadId: string): void {
    const key = syncStateKey(docId, threadId);
    syncStateKeyEpochs.set(key, (syncStateKeyEpochs.get(key) ?? 0) + 1);
  }

  function sameSyncStateEpoch(left: SyncStateEpoch | undefined, right: SyncStateEpoch): boolean {
    return left?.document === right.document && left.key === right.key;
  }

  async function recoverLiveDocFromJournal(
    docId: string,
    commandName: WriteCommand["command"],
    filePath = docId,
  ): Promise<InternalWriteResult | null> {
    try {
      await coordinator.recover(docId);
      staleLiveDocs.delete(docId);
      return null;
    } catch (cause) {
      if (isDocumentNotFoundError(cause)) return documentNotFound(commandName, filePath);
      throw cause;
    }
  }
}

function runtimeKey(session: ActorSession, docId: string): string {
  return `${session.id}\u0000${docId}`;
}

function docIdFromRuntimeKey(key: string): string {
  return key.slice(key.indexOf("\u0000") + 1);
}

function syncStateKey(docId: string, threadId: string): string {
  return `${docId}\u0000${threadId}`;
}
