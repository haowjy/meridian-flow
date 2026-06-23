// Owns per-session runtime Y.Doc lifecycles, live sync, and recovery flags.
import * as Y from "yjs";

import type { ActorSession } from "../ports/actor-session-store.js";
import {
  type DocumentCoordinator,
  isDocumentNotFoundError,
} from "../ports/document-coordinator.js";
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
  ): { ok: true; stateVector: Uint8Array } | { ok: false; response: InternalWriteResult };
  markSynced(session: ActorSession, docId: string, runtime: RuntimeDocumentState): void;
}

export interface RuntimeEvictOptions {
  needsRecovery?: boolean;
}

export interface RuntimeRestoreOptions {
  recoverFromJournal?: boolean;
}

const EMPTY_UPDATE_LENGTH = 2;

export function createRuntimeStore(deps: {
  coordinator: DocumentCoordinator;
  createRuntimeDoc: () => Y.Doc;
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
    markSynced(session, docId, runtime);
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
    if (options.recoverFromJournal || docsNeedingRecovery.has(docId)) {
      const recovered = await recoverLiveDocFromJournal(docId, commandName);
      if (recovered) return recovered;
    }
    const response = await withLiveDocument(coordinator, docId, commandName, (liveDoc) => {
      const restored = createRuntimeDoc();
      Y.applyUpdate(restored, Y.encodeStateAsUpdate(liveDoc), { type: "system" });
      runtime.doc = restored;
      return null;
    });
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
    const response = await withLiveDocument(coordinator, docId, commandName, async (liveDoc) => {
      const update = Y.encodeStateAsUpdate(liveDoc, Y.encodeStateVector(runtime.doc));
      if (hasYjsUpdate(update)) Y.applyUpdate(runtime.doc, update, { type: "system" });
      return null;
    });
    if (isInternalWriteResult(response)) return { ok: false, response };
    markSynced(session, docId, runtime);
    return { ok: true };
  }

  function requireSynced(
    session: ActorSession,
    docId: string,
  ): { ok: true; stateVector: Uint8Array } | { ok: false; response: InternalWriteResult } {
    const state = session.documents.get(docId);
    if (!state) {
      return {
        ok: false,
        response: {
          status: "not_found",
          text: `status: not_found\n\nNo synced snapshot for ${docId}. Run write(command="view", file="${docId}") to re-sync.`,
        },
      };
    }
    return { ok: true, stateVector: state.stateVector };
  }

  function markSynced(session: ActorSession, docId: string, runtime: RuntimeDocumentState): void {
    session.documents.set(docId, {
      stateVector: Y.encodeStateVector(runtime.doc),
    });
  }

  async function recoverLiveDocFromJournal(
    docId: string,
    commandName: WriteCommand["command"],
  ): Promise<InternalWriteResult | null> {
    try {
      await coordinator.recover(docId);
      docsNeedingRecovery.delete(docId);
      return null;
    } catch (cause) {
      if (isDocumentNotFoundError(cause)) return documentNotFound(commandName, docId);
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
