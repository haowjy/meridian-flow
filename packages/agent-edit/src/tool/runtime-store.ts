// Owns per-session runtime Y.Doc lifecycles, live sync, and recovery flags.
import * as Y from "yjs";
import type { ActorSession } from "../ports/actor-session-store.js";
import {
  type DocumentCoordinator,
  isDocumentNotFoundError,
} from "../ports/document-coordinator.js";
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
}

export interface RuntimeEvictOptions {
  markLiveDocStale?: boolean;
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
    staleLiveDocs.delete(docId);
    runtimeDocs.set(runtimeKey(session, docId), runtime);
    const stateVector = Y.encodeStateVector(runtime.doc);
    // At commit, synced and committed snapshots are the same — both
    // represent the runtime state after the commit resolved.
    const snapshot = Y.encodeStateAsUpdate(runtime.doc);
    session.documents.set(docId, { stateVector, committedSnapshot: snapshot });
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
    session.documents.delete(docId);
    if (options.markLiveDocStale) staleLiveDocs.add(docId);
  }

  async function evictThreadRuntimes(
    docId: string,
    threadId: string,
    options: RuntimeEvictOptions = {},
  ): Promise<void> {
    for (const [key, runtime] of [...runtimeDocs]) {
      if (threadId && runtime.threadId !== threadId) continue;
      const runtimeDocId = docIdFromRuntimeKey(key);
      if (docId && runtimeDocId !== docId) continue;
      runtimeDocs.delete(key);
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
    session.documents.set(docId, { stateVector, committedSnapshot });
  }

  function setCommittedSnapshot(session: ActorSession, docId: string, snapshot: Uint8Array): void {
    const existing = session.documents.get(docId);
    if (!existing) return;
    session.documents.set(docId, { ...existing, committedSnapshot: snapshot });
  }

  function getCommittedSnapshot(session: ActorSession, docId: string): Uint8Array | undefined {
    return session.documents.get(docId)?.committedSnapshot;
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
