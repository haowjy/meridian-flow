import type { Hocuspocus } from "@hocuspocus/server";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documentRestorePoints,
  documents,
  documentYjsCheckpoints,
  documentYjsHeads,
  documentYjsUpdates,
  projects,
  threadDocuments,
  turns,
  works,
} from "@meridian/database";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { HTTPError } from "nitro/h3";
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import { KeyedMutex } from "../../shared/keyed-mutex.js";
import { createDrizzleDocumentStore } from "./adapters/drizzle/document-store.js";
import {
  createDocumentSyncService as createInnerDocumentSyncService,
  type DocumentSyncServiceOptions,
  type DocumentSyncService as InnerDocumentSyncService,
} from "./domain/document-sync-service.js";
import { getSchema, markdownToNode, nodeToMarkdown } from "./domain/schemas.js";
import {
  createMirror,
  encodeState,
  encodeStateVector,
  originColumns,
  rebuildMirror,
  YjsDecodeError,
} from "./domain/yjs-mirror.js";
import type {
  DocumentSyncPort,
  DocumentSyncTransport,
  PersistedUpdate,
  SyncError,
  UpdateOrigin,
} from "./ports/document-sync.js";

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

export type DocumentSyncFacade = DocumentSyncPort &
  DocumentSyncTransport & {
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
    requireOwnedDocument(documentId: DocumentId, userId: UserId): Promise<void>;
    initializeMirror(documentId: DocumentId): Promise<void>;
    getLastUpdateAttribution(documentId: DocumentId): Promise<{
      originType: string | null;
      actorTurnId: TurnId | null;
      actorUserId: UserId | null;
      updateSeq: number | null;
    }>;
    applyEditorUpdate(input: {
      documentId: DocumentId;
      update: Uint8Array;
      origin: UpdateOrigin;
      threadId?: ThreadId;
    }): Promise<void>;
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
    getPersistenceQueueMetrics(): Array<{ documentId: string; depth: number; oldestAgeMs: number }>;
    forgetMirror(documentId: DocumentId): void;
  };

export type DocumentSyncService = DocumentSyncFacade;

export type DocumentStore = ReturnType<typeof createDrizzleDocumentStore>;

function toUpdateOrigin(origin: DocumentWriteOrigin): UpdateOrigin {
  if (origin.type === "agent") {
    return { type: "agent", actorTurnId: origin.actorTurnId };
  }
  return { type: "user", userId: origin.actorUserId };
}

function syncErrorToHttp(error: SyncError): HTTPError {
  switch (error.code) {
    case "not_found":
      return new HTTPError({ status: 404, message: "Document not found" });
    case "edit_not_found":
      return new HTTPError({ status: 409, message: "Edit target not found in document" });
    case "ambiguous_edit":
      return new HTTPError({ status: 409, message: "Edit target is ambiguous in document" });
    case "corrupt_state":
      return new HTTPError({ status: 500, message: error.message });
    default:
      return new HTTPError({ status: 500, message: "Document sync failed" });
  }
}

type ActivityDb = Pick<Database, "select" | "update">;

async function touchDocumentActivity(
  db: ActivityDb,
  documentId: DocumentId,
  threadId: ThreadId | undefined,
  now: Date,
  options?: { touchAllThreadDocuments?: boolean },
): Promise<void> {
  const [scope] = await db
    .select({
      workId: contextSources.workId,
      projectId: contextSources.projectId,
    })
    .from(documents)
    .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
    .where(eq(documents.id, documentId))
    .limit(1);

  if (threadId) {
    await db
      .update(threadDocuments)
      .set({ lastTouchedAt: now })
      .where(
        and(eq(threadDocuments.threadId, threadId), eq(threadDocuments.documentId, documentId)),
      );
  } else if (options?.touchAllThreadDocuments) {
    await db
      .update(threadDocuments)
      .set({ lastTouchedAt: now })
      .where(eq(threadDocuments.documentId, documentId));
  }
  if (scope?.workId) {
    await db.update(works).set({ updatedAt: now }).where(eq(works.id, scope.workId));
  }
  if (scope?.projectId) {
    await db
      .update(projects)
      .set({ updatedAt: now, lastActivityAt: now })
      .where(eq(projects.id, scope.projectId));
  }
}

async function updateMarkdownProjection(
  db: Database,
  documentId: DocumentId,
  markdown: string,
  now: Date,
): Promise<void> {
  await db
    .update(documents)
    .set({ markdownProjection: markdown, updatedAt: now })
    .where(eq(documents.id, documentId));
}

type HocuspocusRuntime = Pick<
  Hocuspocus,
  "openDirectConnection" | "documents" | "flushPendingStores"
>;

type QueueTask = {
  startedAt: number;
  run: () => Promise<void>;
};

const DEFAULT_AUTO_CHECKPOINT_EVERY = 100;
const MAX_QUEUE_DEPTH = 1000;
const MAX_QUEUE_AGE_MS = 30_000;

class PersistenceQueues {
  private readonly queues = new Map<string, QueueTask[]>();
  private readonly running = new Set<string>();

  enqueue(documentId: string, task: () => Promise<void>): void {
    const queue = this.queues.get(documentId) ?? [];
    if (queue.length >= MAX_QUEUE_DEPTH) {
      throw new Error(`Collab persistence queue depth exceeded for document ${documentId}`);
    }
    const oldest = queue[0];
    if (oldest && Date.now() - oldest.startedAt > MAX_QUEUE_AGE_MS) {
      throw new Error(`Collab persistence queue age exceeded for document ${documentId}`);
    }
    queue.push({ startedAt: Date.now(), run: task });
    this.queues.set(documentId, queue);
    void this.drain(documentId);
  }

  metrics(): Array<{ documentId: string; depth: number; oldestAgeMs: number }> {
    const now = Date.now();
    return [...this.queues.entries()].map(([documentId, queue]) => ({
      documentId,
      depth: queue.length + (this.running.has(documentId) ? 1 : 0),
      oldestAgeMs: queue[0] ? now - queue[0].startedAt : 0,
    }));
  }

  async drainAll(): Promise<void> {
    await Promise.all([...this.queues.keys()].map((documentId) => this.drain(documentId)));
  }

  private async drain(documentId: string): Promise<void> {
    if (this.running.has(documentId)) return;
    this.running.add(documentId);
    try {
      for (;;) {
        const queue = this.queues.get(documentId);
        const next = queue?.shift();
        if (!next) {
          this.queues.delete(documentId);
          return;
        }
        try {
          await next.run();
        } catch (error) {
          console.error("collab persistence queue task failed", { documentId, error });
        }
      }
    } finally {
      this.running.delete(documentId);
    }
  }
}

function schemaTypeForFiletype(filetype: string): "document" | "code" {
  return filetype === "markdown" ? "document" : "code";
}

function readDocAsMarkdown(document: Y.Doc, filetype = "markdown"): string {
  const schemaType = schemaTypeForFiletype(filetype);
  const fragment = document.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  const root = yXmlFragmentToProseMirrorRootNode(fragment, getSchema(schemaType));
  return nodeToMarkdown(schemaType, root);
}

function writeDocFromMarkdown(document: Y.Doc, filetype: string, markdown: string): void {
  const schemaType = schemaTypeForFiletype(filetype);
  updateYFragment(
    document,
    document.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
    markdownToNode(schemaType, markdown),
    { mapping: new Map(), isOMark: new Map() },
  );
}

async function appendUpdateAndAdvanceHead(input: {
  store: DocumentStore;
  documentId: string;
  update: Uint8Array;
  origin: UpdateOrigin;
  document: Y.Doc;
  filetype: string;
  autoCheckpointEvery: number;
}): Promise<PersistedUpdate> {
  let updateSeq = 0;
  await input.store.transaction(async (store) => {
    updateSeq = await store.appendUpdate({
      documentId: input.documentId,
      updateData: input.update,
      ...originColumns(input.origin),
    });
    const head = await store.getHead(input.documentId);
    const nextHead = {
      documentId: input.documentId,
      fragmentName: PROSEMIRROR_FRAGMENT_NAME,
      filetype: input.filetype,
      latestUpdateSeq: updateSeq,
      latestStateVector: Y.encodeStateVector(input.document),
      latestCheckpointId: head?.latestCheckpointId ?? null,
    };
    await store.upsertHead(nextHead);

    const checkpoint = await store.getLatestCheckpoint(input.documentId);
    const baseSeq = checkpoint ? checkpoint.upToSeq : 0;
    const since = (await store.listUpdatesAfter(input.documentId, baseSeq)).filter(
      (update) => update.seq <= updateSeq,
    ).length;
    if (since >= input.autoCheckpointEvery) {
      const checkpointId = await store.insertCheckpoint({
        documentId: input.documentId,
        state: Y.encodeStateAsUpdate(input.document),
        stateVector: Y.encodeStateVector(input.document),
        upToSeq: updateSeq,
        reason: "auto",
      });
      await store.upsertHead({ ...nextHead, latestCheckpointId: checkpointId });
    }
  });
  return { updateSeq, updateData: input.update };
}

export function createDocumentSyncService(deps: {
  db: Database;
  options?: DocumentSyncServiceOptions;
}): DocumentSyncFacade {
  const autoCheckpointEvery = deps.options?.autoCheckpointEvery ?? DEFAULT_AUTO_CHECKPOINT_EVERY;
  const store = createDrizzleDocumentStore(deps.db);
  const inner = createInnerDocumentSyncService(store, { compaction: false, ...deps.options });
  const facadeMutex = new KeyedMutex();
  const queues = new PersistenceQueues();
  const innerReadAsMarkdown = inner.readAsMarkdown.bind(inner);
  const innerWriteFromMarkdown = inner.writeFromMarkdown.bind(inner);
  const innerTransformFromMarkdown = inner.transformFromMarkdown.bind(inner);
  let hocuspocus: HocuspocusRuntime | null = null;

  function runtime(): HocuspocusRuntime | null {
    return hocuspocus;
  }

  async function filetypeFor(documentId: DocumentId): Promise<string> {
    const head = await store.getHead(documentId);
    if (head) return head.filetype;
    const [document] = await deps.db
      .select({ fileType: documents.fileType })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!document) throw new HTTPError({ status: 404, message: "Document not found" });
    return document.fileType;
  }

  async function assertLocalWriteAllowed(input: {
    documentId: DocumentId;
    origin: DocumentWriteOrigin;
    threadId?: ThreadId;
  }): Promise<void> {
    if (input.threadId) {
      const [row] = await deps.db
        .select({ documentId: threadDocuments.documentId })
        .from(threadDocuments)
        .where(
          and(
            eq(threadDocuments.threadId, input.threadId),
            eq(threadDocuments.documentId, input.documentId),
          ),
        )
        .limit(1);
      if (!row) {
        throw new HTTPError({ status: 403, message: "Document is not in thread scope" });
      }
    }

    if (input.origin.type === "agent") {
      const [turnScope] = await deps.db
        .select({ threadId: turns.threadId })
        .from(turns)
        .where(and(eq(turns.id, input.origin.actorTurnId), eq(turns.role, "assistant")))
        .limit(1);
      if (!turnScope) {
        throw new HTTPError({ status: 400, message: "actorTurnId must be an assistant turn" });
      }
      if (input.threadId && turnScope.threadId !== input.threadId) {
        throw new HTTPError({
          status: 400,
          message: "actorTurnId must belong to the write thread",
        });
      }
      if (!input.threadId) {
        const [row] = await deps.db
          .select({ documentId: threadDocuments.documentId })
          .from(threadDocuments)
          .where(
            and(
              eq(threadDocuments.threadId, turnScope.threadId),
              eq(threadDocuments.documentId, input.documentId),
            ),
          )
          .limit(1);
        if (!row) {
          throw new HTTPError({ status: 403, message: "Document is not in actor turn scope" });
        }
      }
    } else if (!input.threadId) {
      await facade.requireOwnedDocument(input.documentId, input.origin.actorUserId);
    }
  }

  async function writeViaDirectConnection(input: {
    documentId: DocumentId;
    markdown: string;
    origin: UpdateOrigin;
  }): Promise<{ persistedUpdate: PersistedUpdate | null; markdown: string }> {
    const instance = runtime();
    if (!instance) {
      await ensureMirrorForDocument(deps.db, inner, input.documentId);
      const fallback = await innerWriteFromMarkdown(input.documentId, input.markdown, input.origin);
      if (!fallback.ok) throw syncErrorToHttp(fallback.error);
      const read = await innerReadAsMarkdown(input.documentId);
      if (!read.ok) throw syncErrorToHttp(read.error);
      return { persistedUpdate: fallback.value, markdown: read.value };
    }

    const filetype = await filetypeFor(input.documentId);
    const connection = await instance.openDirectConnection(input.documentId, {
      origin: input.origin,
    });
    const document = connection.document;
    if (!document) throw new Error("direct connection closed before write");
    const before = Y.encodeStateVector(document);
    await connection.transact((doc) => writeDocFromMarkdown(doc, filetype, input.markdown));
    const update = Y.encodeStateAsUpdate(document, before);
    const persistedUpdate = update.length
      ? await appendUpdateAndAdvanceHead({
          store,
          documentId: input.documentId,
          update,
          origin: input.origin,
          document,
          filetype,
          autoCheckpointEvery,
        })
      : null;
    const markdown = readDocAsMarkdown(document, filetype);
    await connection.disconnect({ unloadImmediately: false });
    return { persistedUpdate, markdown };
  }

  async function editViaDirectConnection(input: {
    documentId: DocumentId;
    transform: (markdown: string) => string;
    origin: UpdateOrigin;
  }): Promise<{
    beforeMarkdown: string;
    markdown: string;
    persistedUpdate: PersistedUpdate | null;
  }> {
    const instance = runtime();
    if (!instance) {
      await ensureMirrorForDocument(deps.db, inner, input.documentId);
      const fallback = await innerTransformFromMarkdown(
        input.documentId,
        input.transform,
        input.origin,
      );
      if (!fallback.ok) throw syncErrorToHttp(fallback.error);
      return fallback.value;
    }

    const filetype = await filetypeFor(input.documentId);
    const connection = await instance.openDirectConnection(input.documentId, {
      origin: input.origin,
    });
    const document = connection.document;
    if (!document) throw new Error("direct connection closed before edit");
    const before = Y.encodeStateVector(document);
    let beforeMarkdown = "";
    let targetMarkdown = "";
    await connection.transact((doc) => {
      beforeMarkdown = readDocAsMarkdown(doc, filetype);
      targetMarkdown = input.transform(beforeMarkdown);
      writeDocFromMarkdown(doc, filetype, targetMarkdown);
    });
    const update = Y.encodeStateAsUpdate(document, before);
    const persistedUpdate = update.length
      ? await appendUpdateAndAdvanceHead({
          store,
          documentId: input.documentId,
          update,
          origin: input.origin,
          document,
          filetype,
          autoCheckpointEvery,
        })
      : null;
    const markdown = readDocAsMarkdown(document, filetype);
    await connection.disconnect({ unloadImmediately: false });
    return { beforeMarkdown, markdown, persistedUpdate };
  }

  const facade = Object.assign(inner, {
    bindHocuspocus(instance: Hocuspocus): void {
      hocuspocus = instance;
    },

    async loadHocuspocusDocument(documentId: DocumentId): Promise<Uint8Array | undefined> {
      try {
        const head = await store.getHead(documentId);
        if (!head) {
          const [document] = await deps.db
            .select({ markdown: documents.markdownProjection, fileType: documents.fileType })
            .from(documents)
            .where(eq(documents.id, documentId))
            .limit(1);
          if (!document) return undefined;
          const entry = createMirror(document.markdown, document.fileType);
          await store.transaction(async (tx) => {
            const seq = await tx.appendUpdate({
              documentId,
              updateData: encodeState(entry),
              ...originColumns({ type: "system" }),
            });
            await tx.upsertHead({
              documentId,
              fragmentName: PROSEMIRROR_FRAGMENT_NAME,
              filetype: document.fileType,
              latestUpdateSeq: seq,
              latestStateVector: encodeStateVector(entry),
              latestCheckpointId: null,
            });
          });
          return encodeState(entry);
        }

        const checkpoint = await store.getLatestCheckpoint(documentId);
        const updates = await store.listUpdatesAfter(documentId, checkpoint?.upToSeq ?? 0);
        const parts = [
          ...(checkpoint ? [checkpoint.state] : []),
          ...updates
            .filter((update) => update.seq <= head.latestUpdateSeq)
            .map((update) => update.updateData),
        ];
        if (parts.length === 0) return undefined;
        const entry = rebuildMirror(
          head.filetype,
          checkpoint?.state ?? null,
          updates.map((u) => u.updateData),
        );
        return encodeState(entry);
      } catch (error) {
        if (!(error instanceof YjsDecodeError)) throw error;
        await resetMirrorRows(deps.db, documentId);
        const [document] = await deps.db
          .select({ markdown: documents.markdownProjection, fileType: documents.fileType })
          .from(documents)
          .where(eq(documents.id, documentId))
          .limit(1);
        if (!document) return undefined;
        const entry = createMirror(document.markdown, document.fileType);
        await store.transaction(async (tx) => {
          const seq = await tx.appendUpdate({
            documentId,
            updateData: encodeState(entry),
            ...originColumns({ type: "system" }),
          });
          await tx.upsertHead({
            documentId,
            fragmentName: PROSEMIRROR_FRAGMENT_NAME,
            filetype: document.fileType,
            latestUpdateSeq: seq,
            latestStateVector: encodeStateVector(entry),
            latestCheckpointId: null,
          });
        });
        return encodeState(entry);
      }
    },

    persistConnectionUpdate(input: {
      documentId: DocumentId;
      update: Uint8Array;
      origin: UpdateOrigin;
      document: Y.Doc;
    }): void {
      queues.enqueue(input.documentId, async () => {
        await appendUpdateAndAdvanceHead({
          store,
          documentId: input.documentId,
          update: input.update,
          origin: input.origin,
          document: input.document,
          filetype: await filetypeFor(input.documentId),
          autoCheckpointEvery,
        });
      });
    },

    async storeHocuspocusDocument(documentId: DocumentId, document: Y.Doc): Promise<void> {
      const head = await store.getHead(documentId);
      if (!head) return;
      const state = Y.encodeStateAsUpdate(document);
      const checkpointId = await store.insertCheckpoint({
        documentId,
        state,
        stateVector: Y.encodeStateVector(document),
        upToSeq: head.latestUpdateSeq,
        reason: "store",
      });
      await store.upsertHead({ ...head, latestCheckpointId: checkpointId });
      await updateMarkdownProjection(
        deps.db,
        documentId,
        readDocAsMarkdown(document, head.filetype),
        new Date(),
      );
    },

    async drainHocuspocusPersistence(): Promise<void> {
      await queues.drainAll();
      runtime()?.flushPendingStores();
    },

    getPersistenceQueueMetrics() {
      return queues.metrics();
    },

    async initializeMirror(documentId: DocumentId): Promise<void> {
      await ensureMirrorForDocument(deps.db, inner, documentId);
    },

    async writeDocument(input: {
      documentId: DocumentId;
      markdown: string;
      origin: DocumentWriteOrigin;
      threadId?: ThreadId;
    }) {
      return facadeMutex.run(input.documentId, async () => {
        const now = new Date();
        await assertLocalWriteAllowed(input);
        const beforeSeq = await latestUpdateSeq(deps.db, input.documentId);
        const result = await writeViaDirectConnection({
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
    },

    async editDocument(input: {
      documentId: DocumentId;
      transform: (markdown: string) => string;
      origin: DocumentWriteOrigin;
      threadId?: ThreadId;
    }) {
      return facadeMutex.run(input.documentId, async () => {
        const now = new Date();
        await assertLocalWriteAllowed(input);
        const beforeSeq = await latestUpdateSeq(deps.db, input.documentId);
        const result = await editViaDirectConnection({
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
    },

    async readAsMarkdown(documentId: string) {
      const live = runtime()?.documents.get(documentId);
      if (live) {
        return {
          ok: true as const,
          value: readDocAsMarkdown(live, await filetypeFor(documentId as DocumentId)),
        };
      }
      return innerReadAsMarkdown(documentId);
    },

    async requireOwnedDocument(documentId: DocumentId, userId: UserId) {
      const [document] = await deps.db
        .select({ id: documents.id })
        .from(documents)
        .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
        .leftJoin(projects, eq(contextSources.projectId, projects.id))
        .leftJoin(works, eq(contextSources.workId, works.id))
        .where(
          and(
            eq(documents.id, documentId),
            or(eq(projects.userId, userId), eq(works.createdByUserId, userId)),
            isNull(documents.deletedAt),
            isNull(contextSources.deletedAt),
            or(isNull(works.id), isNull(works.deletedAt)),
            or(isNull(projects.id), isNull(projects.deletedAt)),
          ),
        )
        .limit(1);

      if (!document) throw new HTTPError({ status: 404, message: "Document not found" });
    },

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

    async applyEditorUpdate(input: {
      documentId: DocumentId;
      update: Uint8Array;
      origin: UpdateOrigin;
      threadId?: ThreadId;
    }) {
      return facadeMutex.run(input.documentId, async () => {
        const result = await inner.applyUpdate(input.documentId, input.update, input.origin);
        if (!result.ok) throw syncErrorToHttp(result.error);

        const markdownResult = await innerReadAsMarkdown(input.documentId);
        if (!markdownResult.ok) throw syncErrorToHttp(markdownResult.error);

        const now = new Date();
        await updateMarkdownProjection(deps.db, input.documentId, markdownResult.value, now);
        await touchDocumentActivity(deps.db, input.documentId, input.threadId, now, {
          touchAllThreadDocuments: !input.threadId && input.origin.type === "user",
        });
      });
    },
  });

  return facade;
}

async function ensureMirrorForDocument(
  db: Database,
  inner: InnerDocumentSyncService,
  documentId: DocumentId,
): Promise<void> {
  const [document] = await db
    .select({
      markdown: documents.markdownProjection,
      fileType: documents.fileType,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!document) throw new HTTPError({ status: 404, message: "Document not found" });
  let result = await inner.getOrCreateMirror(documentId, document.markdown, document.fileType);
  if (!result.ok && result.error.code === "corrupt_state") {
    await resetMirrorRows(db, documentId);
    inner.forgetMirror?.(documentId);
    result = await inner.getOrCreateMirror(documentId, document.markdown, document.fileType);
  }
  if (!result.ok) throw syncErrorToHttp(result.error);
}

async function resetMirrorRows(db: Database, documentId: DocumentId): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(documentRestorePoints).where(eq(documentRestorePoints.documentId, documentId));
    await tx
      .delete(documentYjsCheckpoints)
      .where(eq(documentYjsCheckpoints.documentId, documentId));
    await tx.delete(documentYjsUpdates).where(eq(documentYjsUpdates.documentId, documentId));
    await tx.delete(documentYjsHeads).where(eq(documentYjsHeads.documentId, documentId));
  });
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

export function createInMemoryDocumentStore(): { phase: "phase4" } {
  return { phase: "phase4" };
}

export type {
  DocumentSyncServiceOptions,
  DocumentSyncTransport,
  PersistedUpdate,
  SyncError,
  UpdateOrigin,
};
