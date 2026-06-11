import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documents,
  documentYjsHeads,
  documentYjsUpdates,
  projects,
  threadDocuments,
  turns,
  works,
} from "@meridian/database";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPError } from "nitro/h3";

export type DocumentWriteOrigin =
  | { type: "agent"; actorTurnId: TurnId }
  | { type: "user"; actorUserId: UserId };

export type DocumentWriteResult = {
  documentId: DocumentId;
  markdown: string;
  updateSeq: number;
  updateData: Buffer;
};

export type DocumentUpdateListener = (update: DocumentWriteResult) => void;

export type DocumentSyncService = {
  writeDocument(input: {
    documentId: DocumentId;
    markdown: string;
    origin: DocumentWriteOrigin;
    threadId?: ThreadId;
  }): Promise<DocumentWriteResult>;
  requireOwnedDocument(documentId: DocumentId, userId: UserId): Promise<void>;
  subscribe(documentId: DocumentId, listener: DocumentUpdateListener): () => void;
};

export type DocumentStore = {
  readonly phase: "phase4";
};

type ActivityDb = Pick<Database, "select" | "update">;

function yjsReplacePayload(documentId: DocumentId, markdown: string): Buffer {
  return Buffer.from(JSON.stringify({ type: "markdown-replace", documentId, markdown }));
}

export function createDocumentSyncService(deps: { db: Database }): DocumentSyncService {
  const listeners = new Map<string, Set<DocumentUpdateListener>>();

  function publish(update: DocumentWriteResult): void {
    for (const listener of listeners.get(update.documentId) ?? []) {
      try {
        listener(update);
      } catch {
        // WebSocket delivery is best-effort after the write transaction commits.
      }
    }
  }

  async function touchDocumentActivity(
    db: ActivityDb,
    documentId: DocumentId,
    threadId: ThreadId | undefined,
    now: Date,
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

  return {
    async writeDocument(input) {
      const now = new Date();
      const updateData = yjsReplacePayload(input.documentId, input.markdown);

      const result = await deps.db.transaction(async (tx) => {
        if (input.origin.type === "agent" && input.threadId) {
          const [actorTurn] = await tx
            .select({ id: turns.id })
            .from(turns)
            .where(
              and(
                eq(turns.id, input.origin.actorTurnId),
                eq(turns.threadId, input.threadId),
                eq(turns.role, "assistant"),
              ),
            )
            .limit(1);
          if (!actorTurn) {
            throw new HTTPError({ status: 400, message: "actorTurnId must be an assistant turn" });
          }
        }

        await tx
          .update(documents)
          .set({ markdownProjection: input.markdown, updatedAt: now })
          .where(eq(documents.id, input.documentId));

        const [update] = await tx
          .insert(documentYjsUpdates)
          .values({
            documentId: input.documentId,
            updateData,
            originType: input.origin.type,
            actorUserId: input.origin.type === "user" ? input.origin.actorUserId : null,
            actorTurnId: input.origin.type === "agent" ? input.origin.actorTurnId : null,
          })
          .returning({ id: documentYjsUpdates.id });
        if (!update) throw new Error("Failed to append Yjs update");

        await tx
          .insert(documentYjsHeads)
          .values({
            documentId: input.documentId,
            latestUpdateSeq: update.id,
            latestStateVector: Buffer.alloc(0),
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: documentYjsHeads.documentId,
            set: {
              latestUpdateSeq: update.id,
              latestStateVector: Buffer.alloc(0),
              updatedAt: now,
            },
          });

        await touchDocumentActivity(tx, input.documentId, input.threadId, now);

        return {
          documentId: input.documentId,
          markdown: input.markdown,
          updateSeq: update.id,
          updateData,
        };
      });

      publish(result);
      return result;
    },

    async requireOwnedDocument(documentId, userId) {
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

    subscribe(documentId, listener) {
      let set = listeners.get(documentId);
      if (!set) {
        set = new Set();
        listeners.set(documentId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(documentId);
      };
    },
  };
}

export function createInMemoryDocumentStore(): DocumentStore {
  return { phase: "phase4" };
}

export function createDrizzleDocumentStore(_db: Database): DocumentStore {
  return createInMemoryDocumentStore();
}
