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
import { and, desc, eq, isNull } from "drizzle-orm";
import { HTTPError } from "nitro/h3";
import { createDrizzleDocumentStore } from "./adapters/drizzle/document-store.js";
import {
  createDocumentSyncService as createInnerDocumentSyncService,
  type DocumentSyncServiceOptions,
  type DocumentSyncService as InnerDocumentSyncService,
} from "./domain/document-sync-service.js";
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
    afterEditorApply(input: {
      documentId: DocumentId;
      origin: UpdateOrigin;
      threadId?: ThreadId;
    }): Promise<void>;
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
      projectId: works.projectId,
    })
    .from(documents)
    .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
    .innerJoin(works, eq(works.id, contextSources.workId))
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

async function validateAgentTurn(
  db: Database,
  threadId: ThreadId | undefined,
  actorTurnId: TurnId,
): Promise<void> {
  if (!threadId) return;
  const [actorTurn] = await db
    .select({ id: turns.id })
    .from(turns)
    .where(
      and(eq(turns.id, actorTurnId), eq(turns.threadId, threadId), eq(turns.role, "assistant")),
    )
    .limit(1);
  if (!actorTurn) {
    throw new HTTPError({ status: 400, message: "actorTurnId must be an assistant turn" });
  }
}

export function createDocumentSyncService(deps: {
  db: Database;
  options?: DocumentSyncServiceOptions;
}): DocumentSyncFacade {
  const store = createDrizzleDocumentStore(deps.db);
  const inner = createInnerDocumentSyncService(store, { compaction: false, ...deps.options });

  return Object.assign(inner, {
    async initializeMirror(documentId: DocumentId): Promise<void> {
      await ensureMirrorForDocument(deps.db, inner, documentId);
    },

    async writeDocument(input: {
      documentId: DocumentId;
      markdown: string;
      origin: DocumentWriteOrigin;
      threadId?: ThreadId;
    }) {
      const now = new Date();
      if (input.origin.type === "agent") {
        await validateAgentTurn(deps.db, input.threadId, input.origin.actorTurnId);
      }
      await ensureMirrorForDocument(deps.db, inner, input.documentId);

      const beforeSeq = await latestUpdateSeq(deps.db, input.documentId);
      const result = await inner.writeFromMarkdown(
        input.documentId,
        input.markdown,
        toUpdateOrigin(input.origin),
      );
      if (!result.ok) throw syncErrorToHttp(result.error);

      const markdownResult = await inner.readAsMarkdown(input.documentId);
      if (!markdownResult.ok) throw syncErrorToHttp(markdownResult.error);
      const { updateSeq, updateData } = await resolveWriteUpdateResult(
        result.value,
        beforeSeq,
        (seq) => latestUpdateData(deps.db, input.documentId, seq),
      );

      await updateMarkdownProjection(deps.db, input.documentId, markdownResult.value, now);
      await touchDocumentActivity(deps.db, input.documentId, input.threadId, now);

      return {
        documentId: input.documentId,
        markdown: markdownResult.value,
        updateSeq,
        updateData,
        originType: input.origin.type,
        actorTurnId: input.origin.type === "agent" ? input.origin.actorTurnId : null,
        actorUserId: input.origin.type === "user" ? input.origin.actorUserId : null,
      };
    },

    async editDocument(input: {
      documentId: DocumentId;
      transform: (markdown: string) => string;
      origin: DocumentWriteOrigin;
      threadId?: ThreadId;
    }) {
      const now = new Date();
      if (input.origin.type === "agent") {
        await validateAgentTurn(deps.db, input.threadId, input.origin.actorTurnId);
      }
      await ensureMirrorForDocument(deps.db, inner, input.documentId);

      const beforeSeq = await latestUpdateSeq(deps.db, input.documentId);
      const result = await inner.transformFromMarkdown(
        input.documentId,
        input.transform,
        toUpdateOrigin(input.origin),
      );
      if (!result.ok) throw syncErrorToHttp(result.error);

      const { beforeMarkdown, markdown, persistedUpdate } = result.value;
      const { updateSeq, updateData } = await resolveWriteUpdateResult(
        persistedUpdate,
        beforeSeq,
        (seq) => latestUpdateData(deps.db, input.documentId, seq),
      );

      await updateMarkdownProjection(deps.db, input.documentId, markdown, now);
      await touchDocumentActivity(deps.db, input.documentId, input.threadId, now);

      return {
        documentId: input.documentId,
        beforeMarkdown,
        markdown,
        updateSeq,
        updateData,
        originType: input.origin.type,
        actorTurnId: input.origin.type === "agent" ? input.origin.actorTurnId : null,
        actorUserId: input.origin.type === "user" ? input.origin.actorUserId : null,
      };
    },

    async requireOwnedDocument(documentId: DocumentId, userId: UserId) {
      const [document] = await deps.db
        .select({ id: documents.id })
        .from(documents)
        .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
        .innerJoin(works, eq(works.id, contextSources.workId))
        .innerJoin(projects, eq(projects.id, works.projectId))
        .where(
          and(
            eq(documents.id, documentId),
            eq(projects.userId, userId),
            eq(works.createdByUserId, userId),
            isNull(documents.deletedAt),
            isNull(contextSources.deletedAt),
            isNull(works.deletedAt),
            isNull(projects.deletedAt),
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

    async afterEditorApply(input: {
      documentId: DocumentId;
      origin: UpdateOrigin;
      threadId?: ThreadId;
    }) {
      const now = new Date();
      const markdownResult = await inner.readAsMarkdown(input.documentId);
      if (!markdownResult.ok) throw syncErrorToHttp(markdownResult.error);
      await updateMarkdownProjection(deps.db, input.documentId, markdownResult.value, now);
      await touchDocumentActivity(deps.db, input.documentId, input.threadId, now, {
        touchAllThreadDocuments: !input.threadId && input.origin.type === "user",
      });
    },
  });
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

export type { DocumentSyncServiceOptions, PersistedUpdate, SyncError, UpdateOrigin };
