/**
 * PostgreSQL adapter for the durable per-thread message queue (`Inbox`). The
 * `provenance`/`body` jsonb reads trust the stored shape via `as unknown as`;
 * this adapter performs no runtime validation at the storage boundary.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { MessageIntent, MessageProvenance } from "@meridian/contracts/threads";
import * as schema from "@meridian/database/schema";
import { and, asc, eq, gt, inArray, isNull, min } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDatabase } from "../../../shared/drizzle-transaction.js";
import type { Inbox, InboxMessage, MessageBody } from "../loop/ports.js";

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toInboxMessage(row: typeof schema.threadInboxMessages.$inferSelect): InboxMessage {
  return {
    id: row.id,
    threadId: row.threadId as ThreadId,
    seq: row.seq,
    intent: row.intent as MessageIntent,
    provenance: row.provenance as unknown as MessageProvenance,
    body: row.body as unknown as MessageBody,
    idempotencyKey: row.idempotencyKey,
    enqueuedAt: toIso(row.enqueuedAt),
    deliveredAt: row.deliveredAt ? toIso(row.deliveredAt) : null,
  };
}

export function createDrizzleInbox(db: DrizzleDatabase): Inbox {
  const db_ = () => currentDrizzleDb(db);

  // One pending read implementation shared by the consumer's `claimPending` and
  // the writer-facing `listPending`; the partial index
  // `thread_inbox_messages_pending` serves it. `listPending` stays distinct at
  // the port so a future mutating claim cannot leak into the read-only path.
  async function selectPending(threadId: ThreadId): Promise<InboxMessage[]> {
    const rows = await db_()
      .select()
      .from(schema.threadInboxMessages)
      .where(
        and(
          eq(schema.threadInboxMessages.threadId, threadId),
          isNull(schema.threadInboxMessages.deliveredAt),
        ),
      )
      .orderBy(asc(schema.threadInboxMessages.seq));
    return rows.map(toInboxMessage);
  }

  return {
    async enqueue(draft) {
      const [inserted] = await db_()
        .insert(schema.threadInboxMessages)
        .values({
          ...(draft.id !== undefined ? { id: draft.id } : {}),
          threadId: draft.threadId,
          intent: draft.intent,
          provenance: draft.provenance,
          body: draft.body,
          idempotencyKey: draft.idempotencyKey,
        })
        .onConflictDoNothing({
          target: [schema.threadInboxMessages.threadId, schema.threadInboxMessages.idempotencyKey],
        })
        .returning();
      if (inserted) return toInboxMessage(inserted);

      const [existing] = await db_()
        .select()
        .from(schema.threadInboxMessages)
        .where(
          and(
            eq(schema.threadInboxMessages.threadId, draft.threadId),
            eq(schema.threadInboxMessages.idempotencyKey, draft.idempotencyKey),
          ),
        )
        .limit(1);
      if (!existing) {
        throw new Error(`Inbox enqueue lost its row: ${draft.idempotencyKey}`);
      }
      return toInboxMessage(existing);
    },

    async claimPending(threadId) {
      return selectPending(threadId);
    },

    async listPending(threadId) {
      return selectPending(threadId);
    },

    async readPendingProjection(threadId) {
      const rows = await db_()
        .select({
          inbox: schema.threadInboxMessages,
          turnId: schema.threadRunLeases.turnId,
          metadata: schema.turns.metadata,
        })
        .from(schema.threadInboxMessages)
        .leftJoin(
          schema.threadRunLeases,
          and(
            eq(schema.threadRunLeases.threadId, schema.threadInboxMessages.threadId),
            gt(schema.threadRunLeases.expiresAt, new Date()),
          ),
        )
        .leftJoin(schema.turns, eq(schema.turns.id, schema.threadRunLeases.turnId))
        .where(
          and(
            eq(schema.threadInboxMessages.threadId, threadId),
            isNull(schema.threadInboxMessages.deliveredAt),
          ),
        )
        .orderBy(asc(schema.threadInboxMessages.seq));
      const first = rows[0];
      const metadata = first?.metadata as
        | { inboxConsumption?: { messageIds?: unknown } }
        | null
        | undefined;
      const messageIds = Array.isArray(metadata?.inboxConsumption?.messageIds)
        ? metadata.inboxConsumption.messageIds.filter((id): id is string => typeof id === "string")
        : [];
      return {
        messages: rows.map((row) => toInboxMessage(row.inbox)),
        run:
          first?.turnId !== null && first?.turnId !== undefined
            ? { turnId: first.turnId, messageIds }
            : first
              ? { turnId: null, messageIds: [] }
              : null,
      };
    },

    async ack(threadId, ids) {
      if (ids.length === 0) return;
      await db_()
        .update(schema.threadInboxMessages)
        .set({ deliveredAt: new Date() })
        .where(
          and(
            eq(schema.threadInboxMessages.threadId, threadId),
            inArray(schema.threadInboxMessages.id, ids),
            isNull(schema.threadInboxMessages.deliveredAt),
          ),
        );
    },

    async pendingMessageThreads(limit) {
      const rows = await db_()
        .select({ threadId: schema.threadInboxMessages.threadId })
        .from(schema.threadInboxMessages)
        .where(
          and(
            eq(schema.threadInboxMessages.intent, "message"),
            isNull(schema.threadInboxMessages.deliveredAt),
          ),
        )
        .groupBy(schema.threadInboxMessages.threadId)
        .orderBy(asc(min(schema.threadInboxMessages.seq)))
        .limit(limit);
      return rows.map((row) => row.threadId as ThreadId);
    },
  };
}
