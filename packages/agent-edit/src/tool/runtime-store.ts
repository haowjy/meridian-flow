// Owns per-session runtime Y.Doc lifecycles, live sync, and recovery flags.
import * as Y from "yjs";

import type { ActorSession } from "../ports/actor-session-store.js";
import {
  type DocumentCoordinator,
  isDocumentNotFoundError,
} from "../ports/document-coordinator.js";
import type { SyncStateStore } from "../ports/sync-state-store.js";
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

export interface RuntimeRecoveryDocument {
  docId: string;
  session: ActorSession;
  runtime: RuntimeDocumentState;
  commandName: WriteCommand["command"];
}

export interface RuntimeStore {
  runtimeFor(session: ActorSession, docId: string): RuntimeDocumentState;
  attachRuntime(session: ActorSession, docId: string, runtime: RuntimeDocumentState): void;
  evictRuntime(session: ActorSession, docId: string, options?: RuntimeEvictOptions): void;
  evictResponseRuntimes(
    documents: readonly RuntimeRecoveryDocument[],
    options?: RuntimeEvictOptions,
  ): void;
  evictThreadRuntimes(docId: string, threadId: string, options?: RuntimeEvictOptions): void;
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
    filePath?: string,
    runtime?: RuntimeDocumentState,
  ): Promise<{ ok: true; stateVector: Uint8Array } | { ok: false; response: InternalWriteResult }>;
  markSynced(session: ActorSession, docId: string, runtime: RuntimeDocumentState): void;
  getCommittedSnapshot(session: ActorSession, docId: string): Uint8Array | undefined;
}

export interface RuntimeEvictOptions {
  needsRecovery?: boolean;
}

export interface RuntimeRestoreOptions {
  recoverFromJournal?: boolean;
  filePath?: string;
}

const EMPTY_UPDATE_LENGTH = 2;

export function createRuntimeStore(deps: {
  coordinator: DocumentCoordinator;
  createRuntimeDoc: () => Y.Doc;
  syncStateStore?: SyncStateStore;
}): RuntimeStore {
  const { coordinator, createRuntimeDoc } = deps;
  const runtimeDocs = new Map<string, RuntimeDocumentState>();
  const docsNeedingRecovery = new Set<string>();

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
    getCommittedSnapshot,
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
    return runtime;
  }

  function attachRuntime(
    session: ActorSession,
    docId: string,
    runtime: RuntimeDocumentState,
  ): void {
    docsNeedingRecovery.delete(docId);
    runtimeDocs.set(runtimeKey(session, docId), runtime);
    const stateVector = Y.encodeStateVector(runtime.doc);
    // At commit, synced and committed snapshots are the same — both
    // represent the runtime state after the commit resolved.
    const snapshot = Y.encodeStateAsUpdate(runtime.doc);
    session.documents.set(docId, { stateVector, committedSnapshot: snapshot });
    persistSyncState(session, docId, stateVector, snapshot, snapshot);
  }

  function evictResponseRuntimes(
    documents: readonly RuntimeRecoveryDocument[],
    options: RuntimeEvictOptions = {},
  ): void {
    for (const document of documents) {
      evictRuntime(document.session, document.docId, options);
    }
  }

  function evictRuntime(
    session: ActorSession,
    docId: string,
    options: RuntimeEvictOptions = {},
  ): void {
    runtimeDocs.delete(runtimeKey(session, docId));
    session.documents.delete(docId);
    if (options.needsRecovery) docsNeedingRecovery.add(docId);
  }

  function evictThreadRuntimes(
    docId: string,
    threadId: string,
    options: RuntimeEvictOptions = {},
  ): void {
    for (const [key, runtime] of [...runtimeDocs]) {
      if (runtime.threadId !== threadId) continue;
      if (!key.endsWith(`\u0000${docId}`)) continue;
      runtimeDocs.delete(key);
      runtime.session.documents.delete(docId);
    }
    if (options.needsRecovery) docsNeedingRecovery.add(docId);
  }

  async function restoreRuntimeFromLive(
    session: ActorSession,
    docId: string,
    runtime: RuntimeDocumentState,
    commandName: WriteCommand["command"],
    options: RuntimeRestoreOptions = {},
  ): Promise<InternalWriteResult | null> {
    const filePath = options.filePath ?? docId;
    if (options.recoverFromJournal || docsNeedingRecovery.has(docId)) {
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
      docsNeedingRecovery.delete(document.docId);
    }
  }

  async function syncLocalFromLive(
    session: ActorSession,
    docId: string,
    runtime: RuntimeDocumentState,
    commandName: WriteCommand["command"],
  ): Promise<{ ok: true } | { ok: false; response: InternalWriteResult }> {
    if (docsNeedingRecovery.has(docId)) {
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
        if (hasYjsUpdate(update)) Y.applyUpdate(runtime.doc, update, { type: "system" });
        return null;
      },
    );
    if (isInternalWriteResult(response)) return { ok: false, response };
    markSynced(session, docId, runtime);
    return { ok: true };
  }

  async function requireSynced(
    session: ActorSession,
    docId: string,
    filePath = docId,
    runtime?: RuntimeDocumentState,
  ): Promise<{ ok: true; stateVector: Uint8Array } | { ok: false; response: InternalWriteResult }> {
    // If the doc needs recovery (invalidated/evicted), don't use stale state
    // — force a read to rebuild from live/journal.
    if (docsNeedingRecovery.has(docId)) {
      return {
        ok: false,
        response: {
          status: "not_found",
          text: `status: not_found\n\nNo synced snapshot for ${filePath}. Run write(command="read", file="${filePath}") to re-sync.`,
        },
      };
    }

    const state = session.documents.get(docId);
    if (state) return { ok: true, stateVector: state.stateVector };

    const persisted = await deps.syncStateStore?.load(docId, session.threadId);
    if (persisted) {
      session.documents.set(docId, {
        stateVector: persisted.stateVector,
        committedSnapshot: persisted.committedSnapshot,
      });
      // Restore runtime from the SYNCED snapshot (which matches stateVector),
      // not the committed snapshot (which is older — detection baseline only).
      if (runtime) {
        const restored = createRuntimeDoc();
        Y.applyUpdate(restored, persisted.syncedSnapshot, { type: "system" });
        runtime.doc = restored;
        runtimeDocs.set(runtimeKey(session, docId), runtime);
        // Persisted state is a fast-start baseline only — merge live truth before mutate.
        const reconciled = await syncLocalFromLive(session, docId, runtime, "read");
        if (!reconciled.ok) return reconciled;
        return { ok: true, stateVector: Y.encodeStateVector(runtime.doc) };
      }
      return { ok: true, stateVector: persisted.stateVector };
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
    void deps.syncStateStore
      ?.save(docId, session.threadId, { stateVector, syncedSnapshot, committedSnapshot })
      .catch(() => undefined);
  }

  async function recoverLiveDocFromJournal(
    docId: string,
    commandName: WriteCommand["command"],
    filePath = docId,
  ): Promise<InternalWriteResult | null> {
    try {
      await coordinator.recover(docId);
      docsNeedingRecovery.delete(docId);
      return null;
    } catch (cause) {
      if (isDocumentNotFoundError(cause)) return documentNotFound(commandName, filePath);
      throw cause;
    }
  }
}

function hasYjsUpdate(update: Uint8Array): boolean {
  return update.length > EMPTY_UPDATE_LENGTH;
}

function runtimeKey(session: ActorSession, docId: string): string {
  return `${session.id}\u0000${docId}`;
}
