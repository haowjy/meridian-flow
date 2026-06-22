/** Drizzle-backed UpdateJournal adapter for persisted Yjs document updates. */

import type {
  JournalSnapshot,
  PersistedUpdate,
  UpdateJournal,
  UpdateMeta,
} from "@meridian/agent-edit";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  documentYjsCheckpoints,
  documentYjsHeads,
  documentYjsReversals,
  documentYjsUpdates,
} from "@meridian/database";
import { and, asc, desc, eq, gt, gte, lt, lte, ne, or, sql } from "drizzle-orm";
import * as Y from "yjs";

type JournalDb = Pick<Database, "select" | "insert" | "update" | "delete" | "transaction">;

type OriginType = "agent" | "human" | "system";

const asDocumentId = (value: string) => value as DocumentId;
const asThreadId = (value: string) => value as ThreadId;
const asTurnId = (value: string) => value as TurnId;
const asOptionalTurnId = (value: string | undefined) => value as TurnId | undefined;
const asUserId = (value: string | undefined) => value as UserId | undefined;

function toBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer);
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

function parseOrigin(meta: UpdateMeta): {
  originType: OriginType;
  actorTurnId?: TurnId;
  actorUserId?: UserId;
} {
  if (meta.origin === "system") {
    return { originType: "system", actorTurnId: asOptionalTurnId(meta.actorTurnId) };
  }

  const separator = meta.origin.indexOf(":");
  if (separator === -1) throw new Error(`Invalid update origin: ${meta.origin}`);

  const kind = meta.origin.slice(0, separator);
  const id = meta.origin.slice(separator + 1);
  if (!id) throw new Error(`Invalid update origin: ${meta.origin}`);

  if (kind === "agent") {
    return { originType: "agent", actorTurnId: asTurnId(meta.actorTurnId ?? id) };
  }
  if (kind === "human") {
    return {
      originType: "human",
      actorTurnId: asOptionalTurnId(meta.actorTurnId),
      actorUserId: asUserId(id),
    };
  }
  throw new Error(`Invalid update origin: ${meta.origin}`);
}

function originFromRow(row: typeof documentYjsUpdates.$inferSelect): string {
  if (row.originType === "agent") return `agent:${row.actorTurnId ?? "unknown"}`;
  if (row.originType === "human") return `human:${row.actorUserId ?? "unknown"}`;
  return "system";
}

function mapUpdate(row: typeof documentYjsUpdates.$inferSelect): PersistedUpdate {
  return {
    seq: row.id,
    update: toBytes(row.updateData),
    meta: {
      origin: originFromRow(row),
      ...(row.actorTurnId ? { actorTurnId: row.actorTurnId } : {}),
      seq: row.id,
    },
  };
}

async function latestCheckpoint(db: JournalDb, documentId: string) {
  const [row] = await db
    .select()
    .from(documentYjsCheckpoints)
    .where(eq(documentYjsCheckpoints.documentId, asDocumentId(documentId)))
    .orderBy(desc(documentYjsCheckpoints.id))
    .limit(1);
  return row ?? null;
}

async function maxUpdateSeq(db: JournalDb, documentId: string): Promise<number> {
  const [row] = await db
    .select({ maxSeq: sql<number>`coalesce(max(${documentYjsUpdates.id}), 0)` })
    .from(documentYjsUpdates)
    .where(eq(documentYjsUpdates.documentId, asDocumentId(documentId)));
  return row?.maxSeq ?? 0;
}

async function insertCheckpoint(
  db: JournalDb,
  documentId: string,
  state: Uint8Array,
  upToSeq: number,
  reason: string,
): Promise<number> {
  const stateVector = Y.encodeStateVectorFromUpdate(state);
  const [row] = await db
    .insert(documentYjsCheckpoints)
    .values({
      documentId: asDocumentId(documentId),
      state: toBuffer(state),
      stateVector: toBuffer(stateVector),
      upToSeq,
      reason,
    })
    .returning({ id: documentYjsCheckpoints.id });
  if (!row) throw new Error("Failed to insert Yjs checkpoint");

  await db
    .insert(documentYjsHeads)
    .values({
      documentId: asDocumentId(documentId),
      latestUpdateSeq: upToSeq,
      latestStateVector: toBuffer(stateVector),
      latestCheckpointId: row.id,
    })
    .onConflictDoUpdate({
      target: documentYjsHeads.documentId,
      set: {
        latestUpdateSeq: upToSeq,
        latestStateVector: toBuffer(stateVector),
        latestCheckpointId: row.id,
        updatedAt: sql`now()`,
      },
    });

  return row.id;
}

async function appendUpdate(
  db: JournalDb,
  documentId: string,
  update: Uint8Array,
  meta: UpdateMeta,
): Promise<number> {
  const origin = parseOrigin(meta);
  const [row] = await db
    .insert(documentYjsUpdates)
    .values({
      documentId: asDocumentId(documentId),
      updateData: toBuffer(update),
      originType: origin.originType,
      actorUserId: origin.actorUserId ?? null,
      actorTurnId: origin.actorTurnId ?? null,
    })
    .returning({ id: documentYjsUpdates.id });
  if (!row) throw new Error("Failed to append Yjs update");
  return row.id;
}

export function createDrizzleJournal(db: JournalDb): UpdateJournal {
  return {
    async append(docId, update, meta) {
      return appendUpdate(db, docId, update, meta);
    },

    async read(docId, opts = {}): Promise<JournalSnapshot> {
      const checkpoint = await latestCheckpoint(db, docId);
      const conditions = [
        eq(documentYjsUpdates.documentId, asDocumentId(docId)),
        gt(documentYjsUpdates.id, checkpoint?.upToSeq ?? 0),
      ];
      if (opts.since !== undefined) conditions.push(gte(documentYjsUpdates.id, opts.since));
      if (opts.until !== undefined) conditions.push(lte(documentYjsUpdates.id, opts.until));

      const rows = await db
        .select()
        .from(documentYjsUpdates)
        .where(and(...conditions))
        .orderBy(asc(documentYjsUpdates.id));

      return {
        checkpoint: checkpoint ? toBytes(checkpoint.state) : null,
        updates: rows.map(mapUpdate),
      };
    },

    async checkpoint(docId, state) {
      await db.transaction(async (tx) => {
        const upToSeq = await maxUpdateSeq(tx as JournalDb, docId);
        await insertCheckpoint(tx as JournalDb, docId, state, upToSeq, "checkpoint");
      });
    },

    async compact(docId, before) {
      return db.transaction(async (tx) => {
        const txDb = tx as JournalDb;
        const checkpoint = await latestCheckpoint(txDb, docId);
        const checkpointSeq = checkpoint?.upToSeq ?? 0;
        const foldRows = await txDb
          .select()
          .from(documentYjsUpdates)
          .where(
            and(
              eq(documentYjsUpdates.documentId, asDocumentId(docId)),
              gt(documentYjsUpdates.id, checkpointSeq),
              lt(documentYjsUpdates.createdAt, before),
            ),
          )
          .orderBy(asc(documentYjsUpdates.id));

        let compactedThroughSeq = checkpointSeq;
        if (foldRows.length > 0) {
          const doc = new Y.Doc({ gc: false });
          if (checkpoint) Y.applyUpdate(doc, toBytes(checkpoint.state));
          for (const row of foldRows) Y.applyUpdate(doc, toBytes(row.updateData));
          compactedThroughSeq = foldRows.at(-1)?.id ?? checkpointSeq;
          await insertCheckpoint(
            txDb,
            docId,
            Y.encodeStateAsUpdate(doc),
            compactedThroughSeq,
            "compact",
          );
        }

        if (compactedThroughSeq > 0) {
          await txDb
            .delete(documentYjsUpdates)
            .where(
              and(
                eq(documentYjsUpdates.documentId, asDocumentId(docId)),
                lte(documentYjsUpdates.id, compactedThroughSeq),
                lt(documentYjsUpdates.createdAt, before),
              ),
            );
        }

        const expired = await txDb
          .update(documentYjsReversals)
          .set({ status: "expired" })
          .where(
            and(
              eq(documentYjsReversals.documentId, asDocumentId(docId)),
              ne(documentYjsReversals.status, "expired"),
              or(
                lt(documentYjsReversals.createdAt, before),
                lt(documentYjsReversals.expiresAt, before),
              ),
            ),
          )
          .returning({ id: documentYjsReversals.id });

        return { updatesFolded: foldRows.length, reversalsExpired: expired.length };
      });
    },

    async persistReversal(docId, undoUpdate, record) {
      let undoUpdateSeq: number | undefined;
      await db.transaction(async (tx) => {
        const txDb = tx as JournalDb;
        undoUpdateSeq = await appendUpdate(txDb, docId, undoUpdate, { origin: "system", seq: 0 });
        await txDb
          .insert(documentYjsReversals)
          .values({
            documentId: asDocumentId(docId),
            threadId: asThreadId(record.threadId),
            turnId: asTurnId(record.turnId),
            status: record.status,
            undoUpdateSeq,
            expiresAt: record.expiresAt ?? null,
            reversedAt: record.reversedAt ?? null,
            reversedByUserId: record.reversedByUserId ?? null,
          })
          .onConflictDoUpdate({
            target: [
              documentYjsReversals.documentId,
              documentYjsReversals.threadId,
              documentYjsReversals.turnId,
            ],
            set: {
              status: record.status,
              undoUpdateSeq,
              expiresAt: record.expiresAt ?? null,
              reversedAt: record.reversedAt ?? null,
              reversedByUserId: record.reversedByUserId ?? null,
            },
          });
      });
      if (undoUpdateSeq === undefined) throw new Error("Failed to persist reversal update");
      record.undoUpdateSeq = undoUpdateSeq;
    },
  };
}
