/** Drizzle-backed destructive delivery queue for safety notices. */
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { pendingNoticeDeliveries, pendingNotices } from "@meridian/database/schema";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import type {
  Notice,
  NoticeInput,
  NoticePort,
  WriterNoticeEvent,
  WriterNoticeListener,
} from "../index.js";

type NoticeDb = Pick<Database, "insert" | "select" | "update" | "delete" | "transaction">;

export function createDrizzleNoticePort(db: NoticeDb): NoticePort {
  const listeners = new Set<WriterNoticeListener>();

  return {
    async record(input) {
      validateNotice(input);
      const writerDocumentId = input.writerVisible ? requireWriterDocumentId(input) : null;
      await runInDrizzleTransaction(db as Database, async () => {
        const tx = currentDrizzleDb(db as Database);
        const [row] = await tx
          .insert(pendingNotices)
          .values({
            kind: input.kind,
            scopeKind: input.scope.kind,
            scopeId: scopeId(input),
            writerDocumentId: writerDocumentId as DocumentId | null,
            message: input.message,
            data: input.data,
            writerVisible: input.writerVisible,
          })
          .returning({ id: pendingNotices.id });
        if (!row) throw new Error("Failed to record safety notice");

        const deliveries =
          input.scope.kind === "thread"
            ? [{ noticeId: row.id, threadId: input.scope.threadId as ThreadId, documentId: null }]
            : [];
        if (deliveries.length > 0) {
          await tx.insert(pendingNoticeDeliveries).values(deliveries).onConflictDoNothing();
        }
      });

      if (input.writerVisible && writerDocumentId) {
        const event: WriterNoticeEvent = {
          documentId: writerDocumentId,
          kind: input.kind,
          message: input.message,
          data: input.data,
        };
        const emit = () => {
          for (const listener of listeners) listener(event);
        };
        if (!deferUntilDrizzleCommit(emit)) emit();
      }
    },

    async drainForModelContext(threadId, activeDocumentIds) {
      return db.transaction(async (tx) => {
        const threadRows = await tx
          .select({ notice: pendingNotices })
          .from(pendingNoticeDeliveries)
          .innerJoin(pendingNotices, eq(pendingNotices.id, pendingNoticeDeliveries.noticeId))
          .where(
            and(
              eq(pendingNoticeDeliveries.threadId, threadId as ThreadId),
              isNull(pendingNoticeDeliveries.documentId),
            ),
          )
          .orderBy(asc(pendingNotices.createdAt), asc(pendingNotices.id));
        const deliveredRows = await tx
          .select({ noticeId: pendingNoticeDeliveries.noticeId })
          .from(pendingNoticeDeliveries)
          .where(eq(pendingNoticeDeliveries.threadId, threadId as ThreadId));
        const delivered = new Set(deliveredRows.map(({ noticeId }) => noticeId));
        const documentRows =
          activeDocumentIds.length === 0
            ? []
            : await tx
                .select()
                .from(pendingNotices)
                .where(
                  and(
                    eq(pendingNotices.scopeKind, "document"),
                    inArray(pendingNotices.scopeId, activeDocumentIds),
                  ),
                )
                .orderBy(asc(pendingNotices.createdAt), asc(pendingNotices.id));
        const pendingDocumentRows = documentRows.filter((notice) => !delivered.has(notice.id));
        const notices = [...threadRows.map(({ notice }) => notice), ...pendingDocumentRows]
          .sort(
            (left, right) =>
              left.createdAt.getTime() - right.createdAt.getTime() || left.id - right.id,
          )
          .map(mapNotice);
        if (notices.length === 0) return [];
        const threadIds = threadRows.map(({ notice }) => notice.id);
        if (threadIds.length > 0) {
          await tx
            .delete(pendingNoticeDeliveries)
            .where(
              and(
                eq(pendingNoticeDeliveries.threadId, threadId as ThreadId),
                inArray(pendingNoticeDeliveries.noticeId, threadIds),
              ),
            );
          await deleteFullyConsumed(tx as NoticeDb, threadIds);
        }
        if (pendingDocumentRows.length > 0) {
          await tx
            .insert(pendingNoticeDeliveries)
            .values(
              pendingDocumentRows.map((notice) => ({
                noticeId: notice.id,
                threadId: threadId as ThreadId,
                documentId: notice.scopeId as DocumentId,
              })),
            )
            .onConflictDoNothing();
        }
        return notices;
      });
    },

    async drainForWriter(documentId) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(pendingNotices)
          .where(
            and(
              eq(pendingNotices.writerDocumentId, documentId as DocumentId),
              eq(pendingNotices.writerVisible, true),
              eq(pendingNotices.writerConsumed, false),
            ),
          )
          .orderBy(asc(pendingNotices.createdAt), asc(pendingNotices.id));
        if (rows.length === 0) return [];
        const ids = rows.map(({ id }) => id);
        await tx
          .update(pendingNotices)
          .set({ writerConsumed: true })
          .where(inArray(pendingNotices.id, ids));
        await deleteFullyConsumed(tx as NoticeDb, ids);
        return rows.map(mapNotice);
      });
    },

    subscribeWriterVisible(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function deleteFullyConsumed(db: NoticeDb, ids: readonly number[]): Promise<void> {
  for (const id of ids) {
    const [notice] = await db
      .select({
        writerVisible: pendingNotices.writerVisible,
        writerConsumed: pendingNotices.writerConsumed,
      })
      .from(pendingNotices)
      .where(eq(pendingNotices.id, id));
    if (!notice || (notice.writerVisible && !notice.writerConsumed)) continue;
    const [delivery] = await db
      .select({ noticeId: pendingNoticeDeliveries.noticeId })
      .from(pendingNoticeDeliveries)
      .where(eq(pendingNoticeDeliveries.noticeId, id));
    if (!delivery) await db.delete(pendingNotices).where(eq(pendingNotices.id, id));
  }
}

function scopeId(input: NoticeInput): string {
  return input.scope.kind === "thread" ? input.scope.threadId : input.scope.documentId;
}

function requireWriterDocumentId(input: NoticeInput): string {
  const documentId = input.data.documentId;
  if (typeof documentId !== "string" || documentId.length === 0) {
    throw new Error("Writer-visible safety notices require data.documentId");
  }
  return documentId;
}

function validateNotice(input: NoticeInput): void {
  if (input.kind !== "late_sweep" && input.kind !== "checkpoint_sweep") return;
  const hashes = input.data.affectedBlockHashes;
  const bodies = input.data.capturedDeletedBodies;
  if (!Array.isArray(hashes) || !Array.isArray(bodies)) {
    throw new Error(`${input.kind} notices require affectedBlockHashes and capturedDeletedBodies`);
  }
  const bodyHashes = new Set(
    bodies.flatMap((body) =>
      typeof body === "object" &&
      body !== null &&
      typeof (body as { hash?: unknown }).hash === "string"
        ? [(body as { hash: string }).hash]
        : [],
    ),
  );
  const missing = hashes.filter(
    (hash): hash is string => typeof hash === "string" && !bodyHashes.has(hash),
  );
  if (missing.length > 0)
    throw new Error(`Safety notice hashes missing captured bodies: ${missing.join(", ")}`);
}

type PendingNoticeRow = typeof pendingNotices.$inferSelect;

function mapNotice(row: PendingNoticeRow): Notice {
  return {
    id: row.id,
    kind: row.kind,
    scope:
      row.scopeKind === "thread"
        ? { kind: "thread", threadId: row.scopeId }
        : { kind: "document", documentId: row.scopeId },
    message: row.message,
    data: row.data,
    writerVisible: row.writerVisible,
    createdAt: row.createdAt,
  };
}
