/**
 * Collab facade: markdown-facing document writes backed by the single
 * Hocuspocus-owned Y.Doc runtime plus the durable Yjs update log.
 */
import type { Hocuspocus } from "@hocuspocus/server";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentYjsUpdates, threadDocuments, turns } from "@meridian/database";
import { and, desc, eq } from "drizzle-orm";
import { HTTPError } from "nitro/h3";
import type * as Y from "yjs";
import type { DocumentAccessPort } from "../../lib/document-access.js";
import { KeyedMutex } from "../../shared/keyed-mutex.js";
import type { EventSink } from "../observability/index.js";
import { createDrizzleDocumentStore } from "./adapters/drizzle/document-store.js";
import { touchDocumentActivity } from "./domain/document-activity.js";
import {
  createDocumentSyncService as createInnerDocumentSyncService,
  type DocumentSyncServiceOptions,
} from "./domain/document-sync-service.js";
import {
  type CollabPersistenceMetrics,
  createHocuspocusCollabAdapter,
} from "./domain/hocuspocus-collab-adapter.js";
import type { DocumentSyncPort, PersistedUpdate, UpdateOrigin } from "./ports/document-sync.js";

export type DocumentWriteOrigin =
  | { type: "agent"; actorTurnId: TurnId }
  | { type: "user"; actorUserId: UserId };

export type DocumentWriteResult = {
  documentId: DocumentId;
  markdown: string;
  updateSeq: number;
  updateData: Buffer;
  originType: DocumentWriteOrigin["type"];
  actorTurnId: TurnId | null;
  actorUserId: UserId | null;
};

export type HocuspocusDocumentSync = {
  bindHocuspocus(instance: Hocuspocus): void;
  loadHocuspocusDocument(documentId: DocumentId): Promise<Uint8Array | undefined>;
  persistConnectionUpdate(input: {
    documentId: DocumentId;
    update: Uint8Array;
    origin: UpdateOrigin;
    document: Y.Doc;
  }): void;
  storeHocuspocusDocument(documentId: DocumentId, document: Y.Doc): Promise<void>;
  drainHocuspocusPersistence(): Promise<void>;
  getPersistenceQueueMetrics(): CollabPersistenceMetrics;
};

export type DocumentSyncFacade = DocumentSyncPort &
  HocuspocusDocumentSync & {
    writeDocument(input: {
      documentId: DocumentId;
      markdown: string;
      origin: DocumentWriteOrigin;
      threadId?: ThreadId;
    }): Promise<DocumentWriteResult>;
    editDocument(input: {
      documentId: DocumentId;
      transform: (markdown: string) => string;
      origin: DocumentWriteOrigin;
      threadId?: ThreadId;
    }): Promise<DocumentWriteResult & { beforeMarkdown: string }>;
    getLastUpdateAttribution(documentId: DocumentId): Promise<{
      originType: string | null;
      actorTurnId: TurnId | null;
      actorUserId: UserId | null;
      updateSeq: number | null;
    }>;
  };

export type DocumentSyncService = DocumentSyncFacade;

export type DocumentStore = ReturnType<typeof createDrizzleDocumentStore>;

const DEFAULT_AUTO_CHECKPOINT_EVERY = 100;

type RequiredDocumentAccess = DocumentAccessPort & {
  requireOwnedDocument(documentId: DocumentId, userId: UserId): Promise<void>;
};

function toUpdateOrigin(origin: DocumentWriteOrigin): UpdateOrigin {
  if (origin.type === "agent") {
    return { type: "agent", actorTurnId: origin.actorTurnId };
  }
  return { type: "user", userId: origin.actorUserId };
}

export function createDocumentSyncService(deps: {
  db: Database;
  documentAccess: RequiredDocumentAccess;
  eventSink?: EventSink;
  options?: DocumentSyncServiceOptions;
}): DocumentSyncFacade {
  const autoCheckpointEvery = deps.options?.autoCheckpointEvery ?? DEFAULT_AUTO_CHECKPOINT_EVERY;
  const store = createDrizzleDocumentStore(deps.db);
  const inner = createInnerDocumentSyncService(store, { compaction: false, ...deps.options });
  const mutex = new KeyedMutex();
  const hocuspocus = createHocuspocusCollabAdapter({
    db: deps.db,
    store,
    autoCheckpointEvery,
    eventSink: deps.eventSink,
  });

  async function assertThreadScope(documentId: DocumentId, threadId: ThreadId): Promise<void> {
    const [row] = await deps.db
      .select({ documentId: threadDocuments.documentId })
      .from(threadDocuments)
      .where(
        and(eq(threadDocuments.threadId, threadId), eq(threadDocuments.documentId, documentId)),
      )
      .limit(1);
    if (!row) {
      throw new HTTPError({ status: 403, message: "Document is not in thread scope" });
    }
  }

  async function assertLocalWriteAllowed(input: {
    documentId: DocumentId;
    origin: DocumentWriteOrigin;
    threadId?: ThreadId;
  }): Promise<void> {
    if (input.origin.type === "user") {
      await deps.documentAccess.requireOwnedDocument(input.documentId, input.origin.actorUserId);
      if (input.threadId) await assertThreadScope(input.documentId, input.threadId);
      return;
    }

    const [turnScope] = await deps.db
      .select({ threadId: turns.threadId })
      .from(turns)
      .where(and(eq(turns.id, input.origin.actorTurnId), eq(turns.role, "assistant")))
      .limit(1);
    if (!turnScope) {
      throw new HTTPError({ status: 400, message: "actorTurnId must be an assistant turn" });
    }
    if (input.threadId && turnScope.threadId !== input.threadId) {
      throw new HTTPError({ status: 400, message: "actorTurnId must belong to the write thread" });
    }
    await assertThreadScope(input.documentId, input.threadId ?? (turnScope.threadId as ThreadId));
  }

  async function writeDocument(input: {
    documentId: DocumentId;
    markdown: string;
    origin: DocumentWriteOrigin;
    threadId?: ThreadId;
  }): Promise<DocumentWriteResult> {
    return mutex.run(input.documentId, async () => {
      const now = new Date();
      await assertLocalWriteAllowed(input);
      const beforeSeq = await latestUpdateSeq(deps.db, input.documentId);
      const result = await hocuspocus.writeDocument({
        documentId: input.documentId,
        markdown: input.markdown,
        origin: toUpdateOrigin(input.origin),
      });
      const { updateSeq, updateData } = await resolveWriteUpdateResult(
        result.persistedUpdate,
        beforeSeq,
        (seq) => latestUpdateData(deps.db, input.documentId, seq),
      );
      await touchDocumentActivity(deps.db, input.documentId, input.threadId, now);
      return {
        documentId: input.documentId,
        markdown: result.markdown,
        updateSeq,
        updateData,
        originType: input.origin.type,
        actorTurnId: input.origin.type === "agent" ? input.origin.actorTurnId : null,
        actorUserId: input.origin.type === "user" ? input.origin.actorUserId : null,
      };
    });
  }

  async function editDocument(input: {
    documentId: DocumentId;
    transform: (markdown: string) => string;
    origin: DocumentWriteOrigin;
    threadId?: ThreadId;
  }): Promise<DocumentWriteResult & { beforeMarkdown: string }> {
    return mutex.run(input.documentId, async () => {
      const now = new Date();
      await assertLocalWriteAllowed(input);
      const beforeSeq = await latestUpdateSeq(deps.db, input.documentId);
      const result = await hocuspocus.editDocument({
        documentId: input.documentId,
        transform: input.transform,
        origin: toUpdateOrigin(input.origin),
      });
      const { updateSeq, updateData } = await resolveWriteUpdateResult(
        result.persistedUpdate,
        beforeSeq,
        (seq) => latestUpdateData(deps.db, input.documentId, seq),
      );
      await touchDocumentActivity(deps.db, input.documentId, input.threadId, now);
      return {
        documentId: input.documentId,
        beforeMarkdown: result.beforeMarkdown,
        markdown: result.markdown,
        updateSeq,
        updateData,
        originType: input.origin.type,
        actorTurnId: input.origin.type === "agent" ? input.origin.actorTurnId : null,
        actorUserId: input.origin.type === "user" ? input.origin.actorUserId : null,
      };
    });
  }

  async function readAsMarkdown(documentId: string) {
    try {
      return {
        ok: true as const,
        value: await hocuspocus.readAsMarkdown(documentId as DocumentId),
      };
    } catch {
      return { ok: false as const, error: { code: "not_found" as const, documentId } };
    }
  }

  return {
    getOrCreateMirror: inner.getOrCreateMirror.bind(inner),
    forgetMirror(documentId: string): void {
      hocuspocus.forgetDocument(documentId as DocumentId);
    },
    readAsMarkdown,
    editFromMarkdown: inner.editFromMarkdown.bind(inner),
    writeFromMarkdown: inner.writeFromMarkdown.bind(inner),
    checkpoint: inner.checkpoint.bind(inner),
    restore: inner.restore.bind(inner),
    listCheckpoints: inner.listCheckpoints.bind(inner),
    writeDocument,
    editDocument,
    bindHocuspocus: hocuspocus.bind,
    loadHocuspocusDocument: hocuspocus.loadDocument,
    persistConnectionUpdate: hocuspocus.persistConnectionUpdate,
    storeHocuspocusDocument: hocuspocus.storeDocument,
    drainHocuspocusPersistence: hocuspocus.drain,
    getPersistenceQueueMetrics: hocuspocus.metrics,
    async getLastUpdateAttribution(documentId: DocumentId) {
      const [update] = await deps.db
        .select({
          id: documentYjsUpdates.id,
          originType: documentYjsUpdates.originType,
          actorTurnId: documentYjsUpdates.actorTurnId,
          actorUserId: documentYjsUpdates.actorUserId,
        })
        .from(documentYjsUpdates)
        .where(eq(documentYjsUpdates.documentId, documentId))
        .orderBy(desc(documentYjsUpdates.id))
        .limit(1);
      return {
        originType: update?.originType ?? null,
        actorTurnId: update?.actorTurnId ?? null,
        actorUserId: update?.actorUserId ?? null,
        updateSeq: update?.id ?? null,
      };
    },
  };
}

async function resolveWriteUpdateResult(
  persisted: PersistedUpdate | null,
  beforeSeq: number | null,
  loadUpdateData: (updateSeq: number) => Promise<Buffer>,
): Promise<{ updateSeq: number; updateData: Buffer }> {
  if (persisted) {
    return {
      updateSeq: persisted.updateSeq,
      updateData: Buffer.from(persisted.updateData),
    };
  }
  const updateSeq = beforeSeq ?? 0;
  const updateData = beforeSeq ? await loadUpdateData(beforeSeq) : Buffer.alloc(0);
  return { updateSeq, updateData };
}

async function latestUpdateSeq(db: Database, documentId: DocumentId): Promise<number | null> {
  const [update] = await db
    .select({ id: documentYjsUpdates.id })
    .from(documentYjsUpdates)
    .where(eq(documentYjsUpdates.documentId, documentId))
    .orderBy(desc(documentYjsUpdates.id))
    .limit(1);
  return update?.id ?? null;
}

async function latestUpdateData(
  db: Database,
  documentId: DocumentId,
  updateSeq: number,
): Promise<Buffer> {
  const [update] = await db
    .select({ updateData: documentYjsUpdates.updateData })
    .from(documentYjsUpdates)
    .where(and(eq(documentYjsUpdates.documentId, documentId), eq(documentYjsUpdates.id, updateSeq)))
    .limit(1);
  return update?.updateData ?? Buffer.alloc(0);
}

export type { DocumentSyncServiceOptions, PersistedUpdate, UpdateOrigin };
