/** Composition root for the server collab domain over @meridian/agent-edit. */
import type { Hocuspocus, TransactionOrigin } from "@hocuspocus/server";
import {
  createAgentEditCore,
  type DocumentCoordinator,
  type DocumentLifecycle,
  fragmentOf,
  isDocumentNotFoundError,
  type PersistedUpdate as JournalUpdate,
  mdxCodec,
  type UpdateJournal,
  type UpdateMeta,
  yProsemirrorModel,
} from "@meridian/agent-edit";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { Err, Ok, type Result } from "../../shared/result.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../observability/index.js";
import { loadDocumentState } from "./adapters/document-loader.js";
import {
  createDrizzleCollabFacadeStore,
  createServerDocumentLifecycle,
} from "./adapters/drizzle-facade-store.js";
import { createDrizzleJournal } from "./adapters/drizzle-journal.js";
import { createHocuspocusCoordinator } from "./adapters/hocuspocus-coordinator.js";
import {
  createInMemoryCoordinator,
  createInMemoryDocumentLifecycle,
  createInMemoryJournal,
  type InMemoryJournal,
} from "./adapters/in-memory/agent-edit.js";
import { touchDocumentActivity, updateMarkdownProjection } from "./domain/document-activity.js";
import type {
  CheckpointInfo,
  CollabDomain,
  CollabPersistenceMetrics,
  DocumentWriteHook,
  DocumentWriteOrigin,
  DocumentWriteResult,
  PersistedUpdate,
  SyncError,
  UpdateOrigin,
} from "./index.js";

export type { DocumentWriteHook } from "./index.js";

type CollabDomainDeps = {
  db: Database;
  eventSink?: EventSink;
};

type CheckpointRecord = {
  id: string;
  documentId: string;
  state: Uint8Array;
  reason: string;
  createdAt: string;
};

export type CollabFacadeStore = {
  createCheckpoint(
    docId: string,
    state: Uint8Array,
    reason: string,
    upToSeq: number,
  ): Promise<string>;
  getCheckpoint(id: string): Promise<CheckpointRecord | null>;
  listCheckpoints(docId: string): Promise<CheckpointRecord[]>;
  latestUpdate(docId: string): Promise<JournalUpdate | null>;
};

export type CollabFacadeDeps = {
  journal: UpdateJournal;
  coordinator: DocumentCoordinator;
  lifecycle: Pick<DocumentLifecycle, "ensureDocument">;
  store: CollabFacadeStore;
  hocuspocus(): Hocuspocus | null;
  bindHocuspocus(instance: Hocuspocus): void;
  eventSink?: EventSink;
  documentWriteHook?: DocumentWriteHook;
};

type RuntimeOrigin = UpdateOrigin | DocumentWriteOrigin;

type SetMarkdownResult = {
  documentId: DocumentId;
  markdown: string;
  updateSeq: number;
  updateData: Uint8Array;
  meta: UpdateMeta;
};

type EditMarkdownResult = SetMarkdownResult & { beforeMarkdown: string };

type PendingAppend = {
  documentId: string;
  startedAt: number;
  promise: Promise<void>;
};

const SYSTEM_ORIGIN: UpdateOrigin = { type: "system" };

export function createCollabDomain(deps: CollabDomainDeps): CollabDomain {
  const journal = createDrizzleJournal(deps.db);
  let boundHocuspocus: Hocuspocus | null = null;
  const hocuspocus = () => {
    if (!boundHocuspocus) throw new Error("Hocuspocus is not bound to the collab domain");
    return boundHocuspocus;
  };
  const coordinator = createHocuspocusCoordinator({ hocuspocus, journal });
  const lifecycle = createServerDocumentLifecycle(deps.db, journal);
  const store = createDrizzleCollabFacadeStore(deps.db);

  return createFacade({
    journal,
    coordinator,
    lifecycle,
    store,
    hocuspocus: () => boundHocuspocus,
    bindHocuspocus(instance) {
      boundHocuspocus = instance;
    },
    eventSink: deps.eventSink,
    documentWriteHook: async ({ documentId, threadId, markdown, at }) => {
      const results = await Promise.allSettled([
        touchDocumentActivity(deps.db, documentId, threadId, at),
        updateMarkdownProjection(deps.db, documentId, markdown, at),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  });
}

export function createInMemoryCollabDomain(): CollabDomain {
  const journal = createInMemoryJournal();
  const coordinator = createInMemoryCoordinator(journal);
  const lifecycle = createInMemoryDocumentLifecycle(coordinator);
  let boundHocuspocus: Hocuspocus | null = null;

  return createFacade({
    journal,
    coordinator,
    lifecycle,
    store: inMemoryStore(journal),
    hocuspocus: () => boundHocuspocus,
    bindHocuspocus(instance) {
      boundHocuspocus = instance;
    },
  });
}

export function createFacade(deps: CollabFacadeDeps): CollabDomain {
  const schema = buildDocumentSchema();
  const codec = mdxCodec({ schema });
  const model = yProsemirrorModel(schema);
  const core = createAgentEditCore({
    journal: deps.journal,
    coordinator: deps.coordinator,
    lifecycle: deps.lifecycle,
    codec,
    model,
  });
  const pendingAppends = new Map<number, PendingAppend>();
  const droppedByDocument = new Map<string, number>();
  let nextPendingId = 1;

  function serializeDoc(doc: Y.Doc): string {
    const blocks = model.getBlocks(doc);
    if (blocks.length === 0) return "";
    return codec.serialize(blocks.map((block) => model.toProsemirrorBlock(doc, block)));
  }

  function syncErrorMessage(error: SyncError): string {
    switch (error.code) {
      case "not_found":
        return `Document not found: ${error.documentId}`;
      case "checkpoint_not_found":
        return `Checkpoint not found: ${error.checkpointId}`;
      case "corrupt_state":
        return error.message;
      case "edit_not_found":
        return `Edit text not found: ${error.oldText}`;
      case "ambiguous_edit":
        return `Edit text is ambiguous (${error.matchCount} matches): ${error.oldText}`;
    }
  }

  function throwSyncError(error: SyncError): never {
    throw new Error(syncErrorMessage(error));
  }

  async function readMarkdown(documentId: string): Promise<Result<string, SyncError>> {
    try {
      const markdown = await deps.coordinator.withDocument(documentId, async (doc) =>
        serializeDoc(doc),
      );
      return Ok(markdown);
    } catch (cause) {
      if (isDocumentNotFoundError(cause)) return Err({ code: "not_found", documentId });
      throw cause;
    }
  }

  async function runDocumentWriteHook(
    event: Omit<Parameters<DocumentWriteHook>[0], "at">,
  ): Promise<void> {
    if (!deps.documentWriteHook) return;
    const hookEvent = { ...event, at: new Date() };
    try {
      // The journal/live-doc write is the source of truth. The read-model hook is
      // awaited for freshness, but its failure is logged and never turns the
      // committed write into an error.
      await deps.documentWriteHook(hookEvent);
    } catch (cause) {
      if (!deps.eventSink) return;
      emitEvent(deps.eventSink, {
        level: "error",
        source: "collab.document_write",
        name: "post_write_hook.failed",
        payload: {
          documentId: hookEvent.documentId,
          threadId: hookEvent.threadId ?? null,
          ...unknownToEventPayload(cause),
        },
      });
    }
  }

  function parseMarkdown(
    documentId: DocumentId,
    markdown: string,
  ): Result<ReturnType<typeof codec.parse>, SyncError> {
    try {
      return Ok(codec.parse(markdown));
    } catch (cause) {
      return Err({
        code: "corrupt_state",
        documentId,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  async function replaceLiveDocumentMarkdown(
    documentId: DocumentId,
    liveDoc: Y.Doc,
    parsed: ReturnType<typeof codec.parse>,
    origin: RuntimeOrigin,
  ): Promise<Result<SetMarkdownResult, SyncError>> {
    const draft = new Y.Doc({ gc: false });
    Y.applyUpdate(draft, Y.encodeStateAsUpdate(liveDoc));
    const beforeVector = Y.encodeStateVector(draft);
    const yjsOrigin = yjsTransactionOrigin(origin);
    draft.transact(() => {
      const fragment = fragmentOf(draft);
      if (fragment.length > 0) fragment.delete(0, fragment.length);
      model.insertBlocks(draft, null, parsed);
    }, yjsOrigin);
    const update = Y.encodeStateAsUpdate(draft, beforeVector);
    const meta = metaForOrigin(origin);
    const seq = await deps.journal.append(documentId, update, meta);
    Y.applyUpdate(liveDoc, update, yjsOrigin);
    return Ok({
      documentId,
      markdown: serializeDoc(draft),
      updateSeq: seq,
      updateData: update,
      meta: { ...meta, seq },
    });
  }

  async function setMarkdown(
    documentId: DocumentId,
    markdown: string,
    origin: RuntimeOrigin,
    threadId?: ThreadId,
  ): Promise<Result<SetMarkdownResult, SyncError>> {
    const parsed = parseMarkdown(documentId, markdown);
    if (!parsed.ok) return parsed;

    await deps.lifecycle.ensureDocument(documentId);

    try {
      const result = await deps.coordinator.withDocument(documentId, (liveDoc) =>
        replaceLiveDocumentMarkdown(documentId, liveDoc, parsed.value, origin),
      );
      if (result.ok) {
        await runDocumentWriteHook({
          documentId: result.value.documentId,
          threadId,
          markdown: result.value.markdown,
        });
      }
      return result;
    } catch (cause) {
      if (isDocumentNotFoundError(cause)) return Err({ code: "not_found", documentId });
      throw cause;
    }
  }

  async function editMarkdown(
    documentId: DocumentId,
    transform: (markdown: string) => string,
    origin: RuntimeOrigin,
    threadId?: ThreadId,
  ): Promise<Result<EditMarkdownResult, SyncError>> {
    await deps.lifecycle.ensureDocument(documentId);

    try {
      const result = await deps.coordinator.withDocument(documentId, async (liveDoc) => {
        const beforeMarkdown = serializeDoc(liveDoc);
        const parsed = parseMarkdown(documentId, transform(beforeMarkdown));
        if (!parsed.ok) return parsed;

        const result = await replaceLiveDocumentMarkdown(documentId, liveDoc, parsed.value, origin);
        return result.ok ? Ok({ ...result.value, beforeMarkdown }) : result;
      });
      if (result.ok) {
        await runDocumentWriteHook({
          documentId: result.value.documentId,
          threadId,
          markdown: result.value.markdown,
        });
      }
      return result;
    } catch (cause) {
      if (isDocumentNotFoundError(cause)) return Err({ code: "not_found", documentId });
      throw cause;
    }
  }

  function persistedUpdate(result: SetMarkdownResult): PersistedUpdate {
    return { updateSeq: result.updateSeq, updateData: result.updateData };
  }

  function documentWriteResult(
    result: SetMarkdownResult,
    origin: DocumentWriteOrigin,
  ): DocumentWriteResult {
    return {
      documentId: result.documentId,
      markdown: result.markdown,
      updateSeq: result.updateSeq,
      updateData: Buffer.from(result.updateData),
      originType: origin.type,
      actorTurnId: origin.type === "agent" ? origin.actorTurnId : null,
      actorUserId: origin.type === "user" ? origin.actorUserId : null,
    };
  }

  async function latestUpdateSeq(documentId: string): Promise<number> {
    return (await deps.store.latestUpdate(documentId))?.seq ?? 0;
  }

  async function drainPending(documentId?: string): Promise<void> {
    while (true) {
      const pending = [...pendingAppends.values()].filter(
        (entry) => !documentId || entry.documentId === documentId,
      );
      if (pending.length === 0) return;
      await Promise.allSettled(pending.map((entry) => entry.promise));
    }
  }

  function trackAppend(documentId: string, promise: Promise<number>): void {
    const id = nextPendingId++;
    const tracked = promise
      .then(() => undefined)
      .catch((cause) => {
        droppedByDocument.set(documentId, (droppedByDocument.get(documentId) ?? 0) + 1);
        if (deps.eventSink) {
          emitEvent(deps.eventSink, {
            level: "error",
            source: "collab.hocuspocus",
            name: "persistence_append.failed",
            payload: {
              documentId,
              error: cause instanceof Error ? cause.message : String(cause),
            },
          });
        }
      })
      .finally(() => {
        pendingAppends.delete(id);
      });
    pendingAppends.set(id, { documentId, startedAt: Date.now(), promise: tracked });
  }

  function latestMetrics(): CollabPersistenceMetrics {
    const byDocument = new Map<
      string,
      { depth: number; oldestStartedAt: number; dropped: number }
    >();
    for (const entry of pendingAppends.values()) {
      const current = byDocument.get(entry.documentId) ?? {
        depth: 0,
        oldestStartedAt: entry.startedAt,
        dropped: droppedByDocument.get(entry.documentId) ?? 0,
      };
      current.depth += 1;
      current.oldestStartedAt = Math.min(current.oldestStartedAt, entry.startedAt);
      byDocument.set(entry.documentId, current);
    }
    for (const [documentId, dropped] of droppedByDocument) {
      if (!byDocument.has(documentId) && dropped > 0) {
        byDocument.set(documentId, { depth: 0, oldestStartedAt: Date.now(), dropped });
      }
    }
    const hocuspocus = deps.hocuspocus();
    return {
      queues: [...byDocument.entries()].map(([documentId, queue]) => ({
        documentId,
        depth: queue.depth,
        oldestAgeMs: queue.depth === 0 ? 0 : Date.now() - queue.oldestStartedAt,
        dropped: queue.dropped,
      })),
      liveDocumentCount: hocuspocus?.getDocumentsCount() ?? hocuspocus?.documents.size ?? 0,
      openConnectionCount: hocuspocus?.getConnectionsCount() ?? 0,
    };
  }

  return {
    readAsMarkdown(documentId) {
      return readMarkdown(documentId);
    },

    async editFromMarkdown(documentId, oldText, newText, origin) {
      const context = writeContextForOrigin(origin);
      const viewed = await core.write(
        { command: "view", file: documentId, format: "full" },
        context,
      );
      const viewStatus = statusOf(viewed);
      if (viewStatus === "document_not_found") return Err({ code: "not_found", documentId });
      if (viewStatus && viewStatus !== "success") {
        return Err({ code: "edit_not_found", oldText });
      }

      const edited = await core.write(
        { command: "replace", file: documentId, find: oldText, content: newText },
        context,
      );
      const status = statusOf(edited);
      if (status === "success") {
        const latest = await deps.store.latestUpdate(documentId);
        return Ok(latest ? { updateSeq: latest.seq, updateData: latest.update } : null);
      }
      if (status === "document_not_found") return Err({ code: "not_found", documentId });
      if (status === "ambiguous_match") {
        return Err({
          code: "ambiguous_edit",
          oldText,
          matchCount: matchCountFromResponse(edited),
        });
      }
      if (status === "not_found") return Err({ code: "edit_not_found", oldText });
      throw new Error(edited);
    },

    async writeFromMarkdown(documentId, markdown, origin) {
      const result = await setMarkdown(documentId as DocumentId, markdown, origin);
      return result.ok ? Ok(persistedUpdate(result.value)) : result;
    },

    async checkpoint(documentId, reason) {
      try {
        const { state, upToSeq } = await deps.coordinator.withDocument(documentId, async (doc) => {
          const upToSeq = await latestUpdateSeq(documentId);
          // upToSeq must be ≤ the updates reflected in state; any later
          // update is replayed after the checkpoint, which is safe in Yjs.
          return { state: Y.encodeStateAsUpdate(doc), upToSeq };
        });
        return Ok(await deps.store.createCheckpoint(documentId, state, reason, upToSeq));
      } catch (cause) {
        if (isDocumentNotFoundError(cause)) return Err({ code: "not_found", documentId });
        throw cause;
      }
    },

    async restore(documentId, checkpointId) {
      const checkpoint = await deps.store.getCheckpoint(checkpointId);
      if (!checkpoint || checkpoint.documentId !== documentId) {
        return Err({ code: "checkpoint_not_found", checkpointId });
      }
      try {
        const restored = new Y.Doc({ gc: false });
        Y.applyUpdate(restored, checkpoint.state);
        const result = await setMarkdown(
          documentId as DocumentId,
          serializeDoc(restored),
          SYSTEM_ORIGIN,
        );
        if (!result.ok) return result;
        return Ok(undefined);
      } catch (cause) {
        return Err({
          code: "corrupt_state",
          documentId,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },

    async listCheckpoints(documentId) {
      const checkpoints = await deps.store.listCheckpoints(documentId);
      return Ok(
        checkpoints.map(
          (checkpoint): CheckpointInfo => ({
            id: checkpoint.id,
            reason: checkpoint.reason,
            createdAt: checkpoint.createdAt,
          }),
        ),
      );
    },

    async writeDocument(input) {
      const result = await setMarkdown(
        input.documentId,
        input.markdown,
        input.origin,
        input.threadId,
      );
      if (!result.ok) throwSyncError(result.error);
      return documentWriteResult(result.value, input.origin);
    },

    async editDocument(input) {
      const result = await editMarkdown(
        input.documentId,
        input.transform,
        input.origin,
        input.threadId,
      );
      if (!result.ok) throwSyncError(result.error);
      return {
        ...documentWriteResult(result.value, input.origin),
        beforeMarkdown: result.value.beforeMarkdown,
      };
    },

    async getLastUpdateAttribution(documentId) {
      const latest = await deps.store.latestUpdate(documentId);
      if (!latest) {
        return { originType: null, actorTurnId: null, actorUserId: null, updateSeq: null };
      }
      return { ...attributionFromMeta(latest.meta), updateSeq: latest.seq };
    },

    bindHocuspocus(instance) {
      deps.bindHocuspocus(instance);
    },

    async loadHocuspocusDocument(documentId) {
      return (await loadDocumentState(deps.journal, documentId)) ?? undefined;
    },

    persistConnectionUpdate(input) {
      trackAppend(
        input.documentId,
        deps.journal.append(input.documentId, input.update, metaForOrigin(input.origin)),
      );
    },

    async storeHocuspocusDocument(documentId, document) {
      await drainPending(documentId);
      const upToSeq = await latestUpdateSeq(documentId);
      // upToSeq must be ≤ the updates reflected in state; appends after this
      // point are intentionally replayed when the document reloads.
      await deps.journal.checkpoint(documentId, Y.encodeStateAsUpdate(document), upToSeq);
    },

    drainHocuspocusPersistence() {
      return drainPending();
    },

    getPersistenceQueueMetrics() {
      return latestMetrics();
    },
  };
}

function inMemoryStore(journal: InMemoryJournal): CollabFacadeStore {
  return {
    createCheckpoint: (docId, state, reason, upToSeq) =>
      journal.createCheckpoint(docId, state, reason, upToSeq),
    getCheckpoint: (id) => journal.getCheckpoint(id),
    listCheckpoints: (docId) => journal.listCheckpoints(docId),
    latestUpdate: (docId) => journal.latestUpdate(docId),
  };
}

function statusOf(response: string): string | null {
  return response.match(/^status: ([^\n]+)/)?.[1] ?? null;
}

function matchCountFromResponse(response: string): number {
  const parsed = Number(response.match(/Found (\d+) matches/)?.[1] ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function yjsTransactionOrigin(origin: RuntimeOrigin): TransactionOrigin {
  return { source: "local", context: { origin } };
}

function metaForOrigin(origin: RuntimeOrigin): UpdateMeta {
  if (origin.type === "agent") {
    return { origin: `agent:${origin.actorTurnId}`, actorTurnId: origin.actorTurnId, seq: 0 };
  }
  if (origin.type === "user") {
    const userId = "actorUserId" in origin ? origin.actorUserId : origin.userId;
    return { origin: `human:${userId}`, seq: 0 };
  }
  if (origin.type === "import") {
    // Imports initiated by a user are human journal updates; a future optional-user import maps to system.
    return origin.userId
      ? { origin: `human:${origin.userId}`, seq: 0 }
      : { origin: "system", seq: 0 };
  }
  return { origin: "system", seq: 0 };
}

function writeContextForOrigin(origin: UpdateOrigin): {
  sessionId: string;
  threadId: string;
  turnId?: string;
} {
  const meta = metaForOrigin(origin);
  return {
    sessionId: meta.origin,
    threadId: meta.actorTurnId ?? meta.origin,
    ...(meta.actorTurnId ? { turnId: meta.actorTurnId } : {}),
  };
}

function attributionFromMeta(meta: UpdateMeta): {
  originType: string | null;
  actorTurnId: TurnId | null;
  actorUserId: UserId | null;
} {
  if (meta.origin === "system") {
    return {
      originType: "system",
      actorTurnId: (meta.actorTurnId as TurnId | undefined) ?? null,
      actorUserId: null,
    };
  }
  const separator = meta.origin.indexOf(":");
  if (separator === -1) {
    return { originType: null, actorTurnId: null, actorUserId: null };
  }
  const kind = meta.origin.slice(0, separator);
  const id = meta.origin.slice(separator + 1);
  if (kind === "agent") {
    return {
      originType: "agent",
      actorTurnId: ((meta.actorTurnId ?? id) as TurnId) || null,
      actorUserId: null,
    };
  }
  if (kind === "human") {
    return {
      originType: "user",
      actorTurnId: (meta.actorTurnId as TurnId | undefined) ?? null,
      actorUserId: (id as UserId) || null,
    };
  }
  return { originType: null, actorTurnId: null, actorUserId: null };
}
