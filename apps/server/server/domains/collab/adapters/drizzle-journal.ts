/** Drizzle-backed collab persistence for Yjs updates, checkpoints, and lifecycle. */

import type {
  DocumentLifecycle,
  JournalSnapshot,
  PersistedUpdate,
  ReversalRecord,
  ReversalStatus,
  UpdateJournal,
  UpdateMeta,
} from "@meridian/agent-edit";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  agentEditMutations,
  agentEditWidCounters,
  documentYjsCheckpoints,
  documentYjsHeads,
  documentYjsReversals,
  documentYjsUpdates,
} from "@meridian/database";
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, ne, or, sql } from "drizzle-orm";
import * as Y from "yjs";

type JournalDb = Pick<Database, "select" | "insert" | "update" | "delete" | "transaction">;

type OriginType = "agent" | "human" | "system";
type UpdateMetaMode = "journal" | "latest";

export type FacadeCheckpointRecord = {
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
  getCheckpoint(id: string): Promise<FacadeCheckpointRecord | null>;
  listCheckpoints(docId: string): Promise<FacadeCheckpointRecord[]>;
  latestUpdate(docId: string): Promise<PersistedUpdate | null>;
};

export type DrizzleCollabPersistence = {
  journal: UpdateJournal;
  lifecycle: DocumentLifecycle;
  store: CollabFacadeStore;
};

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

function metaFromUpdateRow(
  row: typeof documentYjsUpdates.$inferSelect,
  mode: UpdateMetaMode,
): UpdateMeta {
  if (row.originType === "agent") {
    const originActor = row.actorTurnId ?? (mode === "journal" ? "unknown" : undefined);
    if (originActor) {
      return {
        origin: `agent:${originActor}`,
        ...(row.actorTurnId ? { actorTurnId: row.actorTurnId } : {}),
        seq: row.id,
      };
    }
  }
  if (row.originType === "human" || (mode === "latest" && row.originType === "user")) {
    const originActor = row.actorUserId ?? (mode === "journal" ? "unknown" : undefined);
    if (originActor) {
      return {
        origin: `human:${originActor}`,
        ...(row.actorTurnId ? { actorTurnId: row.actorTurnId } : {}),
        seq: row.id,
      };
    }
  }
  return {
    origin: "system",
    ...(row.actorTurnId ? { actorTurnId: row.actorTurnId } : {}),
    seq: row.id,
  };
}

function mapUpdate(
  row: typeof documentYjsUpdates.$inferSelect,
  mode: UpdateMetaMode = "journal",
): PersistedUpdate {
  return {
    seq: row.id,
    update: toBytes(row.updateData),
    meta: metaFromUpdateRow(row, mode),
  };
}

function mapReversal(row: typeof documentYjsReversals.$inferSelect): ReversalRecord {
  return {
    documentId: row.documentId,
    threadId: row.threadId,
    turnId: row.turnId,
    status: row.status,
    undoUpdateSeq: row.undoUpdateSeq,
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
    ...(row.reversedAt ? { reversedAt: row.reversedAt } : {}),
    ...(row.reversedByUserId ? { reversedByUserId: row.reversedByUserId } : {}),
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

async function upsertHead(
  db: JournalDb,
  documentId: string,
  input: {
    latestUpdateSeq?: number;
    latestStateVector?: Uint8Array | null;
    latestCheckpointId?: number | null;
  } = {},
): Promise<void> {
  await db
    .insert(documentYjsHeads)
    .values({
      documentId: asDocumentId(documentId),
      latestUpdateSeq: input.latestUpdateSeq ?? 0,
      latestStateVector: input.latestStateVector ? toBuffer(input.latestStateVector) : null,
      latestCheckpointId: input.latestCheckpointId ?? null,
    })
    .onConflictDoUpdate({
      target: documentYjsHeads.documentId,
      set: {
        ...(input.latestUpdateSeq !== undefined ? { latestUpdateSeq: input.latestUpdateSeq } : {}),
        ...(input.latestStateVector !== undefined
          ? {
              latestStateVector: input.latestStateVector ? toBuffer(input.latestStateVector) : null,
            }
          : {}),
        ...(input.latestCheckpointId !== undefined
          ? { latestCheckpointId: input.latestCheckpointId }
          : {}),
        updatedAt: sql`now()`,
      },
    });
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

  await upsertHead(db, documentId, {
    latestUpdateSeq: upToSeq,
    latestStateVector: stateVector,
    latestCheckpointId: row.id,
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

async function appendMutation(
  db: JournalDb,
  input: { documentId: string; threadId: string; turnId: string; createdSeq: number },
): Promise<number> {
  const [counter] = await db
    .insert(agentEditWidCounters)
    .values({
      documentId: asDocumentId(input.documentId),
      threadId: asThreadId(input.threadId),
      nextWid: 1,
    })
    .onConflictDoUpdate({
      target: [agentEditWidCounters.documentId, agentEditWidCounters.threadId],
      set: {
        nextWid: sql`${agentEditWidCounters.nextWid} + 1`,
      },
    })
    .returning({ wId: agentEditWidCounters.nextWid });
  if (!counter) throw new Error("Failed to allocate agent edit w-id");

  const [row] = await db
    .insert(agentEditMutations)
    .values({
      wId: counter.wId,
      documentId: asDocumentId(input.documentId),
      threadId: asThreadId(input.threadId),
      turnId: asTurnId(input.turnId),
      status: "active",
      createdSeq: input.createdSeq,
    })
    .returning({ wId: agentEditMutations.wId });
  if (!row) throw new Error("Failed to insert agent edit mutation");
  return row.wId;
}

async function reverseMutationsForTurn(
  db: JournalDb,
  input: { documentId: string; threadId: string; turnId: string; undoUpdateSeq: number; at: Date },
): Promise<void> {
  await db
    .update(agentEditMutations)
    .set({
      status: "reversed",
      undoUpdateSeq: input.undoUpdateSeq,
      reversedAt: input.at,
      reversedBy: "agent",
    })
    .where(
      and(
        eq(agentEditMutations.documentId, asDocumentId(input.documentId)),
        eq(agentEditMutations.threadId, asThreadId(input.threadId)),
        eq(agentEditMutations.turnId, asTurnId(input.turnId)),
      ),
    );
}

async function reactivateMutationsForTurn(
  db: JournalDb,
  input: { documentId: string; threadId: string; turnId: string },
): Promise<void> {
  await db
    .update(agentEditMutations)
    .set({
      status: "active",
      undoUpdateSeq: null,
      reversedAt: null,
      reversedBy: null,
    })
    .where(
      and(
        eq(agentEditMutations.documentId, asDocumentId(input.documentId)),
        eq(agentEditMutations.threadId, asThreadId(input.threadId)),
        eq(agentEditMutations.turnId, asTurnId(input.turnId)),
      ),
    );
}

function mapCheckpoint(row: typeof documentYjsCheckpoints.$inferSelect): FacadeCheckpointRecord {
  return {
    id: String(row.id),
    documentId: row.documentId,
    state: toBytes(row.state),
    reason: row.reason ?? "checkpoint",
    createdAt: row.createdAt.toISOString(),
  };
}

export function createDrizzleJournal(db: JournalDb): UpdateJournal {
  return {
    async append(docId, update, meta) {
      return appendUpdate(db, docId, update, meta);
    },

    async appendBatch(entries) {
      if (entries.length === 0) return [];
      return db.transaction(async (tx) => {
        const txDb = tx as JournalDb;
        const results: Array<{ seq: number; wId?: number }> = [];
        for (const entry of entries) {
          const seq = await appendUpdate(txDb, entry.docId, entry.update, entry.meta);
          const wId = entry.mutation
            ? await appendMutation(txDb, {
                documentId: entry.docId,
                threadId: entry.mutation.threadId,
                turnId: entry.mutation.turnId,
                createdSeq: seq,
              })
            : undefined;
          results.push(wId === undefined ? { seq } : { seq, wId });
        }
        return results;
      });
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
        updates: rows.map((row) => mapUpdate(row)),
      };
    },

    async checkpoint(docId, state, upToSeq) {
      await db.transaction(async (tx) => {
        // upToSeq must be ≤ the updates reflected in state; replaying extra
        // updates is idempotent, but skipping one loses durable document data.
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
            reversedByUserId: asUserId(record.reversedByUserId) ?? null,
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
              reversedByUserId: asUserId(record.reversedByUserId) ?? null,
            },
          });
        await reverseMutationsForTurn(txDb, {
          documentId: docId,
          threadId: record.threadId,
          turnId: record.turnId,
          undoUpdateSeq,
          at: record.reversedAt ?? new Date(),
        });
      });
      if (undoUpdateSeq === undefined) throw new Error("Failed to persist reversal update");
      record.undoUpdateSeq = undoUpdateSeq;
    },

    async persistRedo(docId, redoUpdate, ref, meta) {
      return db.transaction(async (tx) => {
        const txDb = tx as JournalDb;
        const [reversal] = await txDb
          .select({ status: documentYjsReversals.status })
          .from(documentYjsReversals)
          .where(
            and(
              eq(documentYjsReversals.documentId, asDocumentId(docId)),
              eq(documentYjsReversals.threadId, asThreadId(ref.threadId)),
              eq(documentYjsReversals.turnId, asTurnId(ref.turnId)),
            ),
          )
          .for("update")
          .limit(1);

        if (reversal?.status !== "reversed") return { consumed: false };

        const seq = await appendUpdate(txDb, docId, redoUpdate, meta);
        await txDb
          .update(documentYjsReversals)
          .set({ status: "redone" })
          .where(
            and(
              eq(documentYjsReversals.documentId, asDocumentId(docId)),
              eq(documentYjsReversals.threadId, asThreadId(ref.threadId)),
              eq(documentYjsReversals.turnId, asTurnId(ref.turnId)),
            ),
          );
        await reactivateMutationsForTurn(txDb, {
          documentId: docId,
          threadId: ref.threadId,
          turnId: ref.turnId,
        });

        return { consumed: true, seq };
      });
    },

    async readReversals(docId, opts = {}) {
      const conditions = [eq(documentYjsReversals.documentId, asDocumentId(docId))];
      if (opts.threadId !== undefined) {
        conditions.push(eq(documentYjsReversals.threadId, asThreadId(opts.threadId)));
      }
      if (opts.status !== undefined && opts.status.length === 0) return [];
      if (opts.status !== undefined) {
        conditions.push(inArray(documentYjsReversals.status, opts.status as ReversalStatus[]));
      }

      const rows = await db
        .select()
        .from(documentYjsReversals)
        .where(and(...conditions))
        .orderBy(asc(documentYjsReversals.reversedAt), asc(documentYjsReversals.undoUpdateSeq));
      return rows.map(mapReversal);
    },
  };
}

export function createServerDocumentLifecycle(
  db: JournalDb,
  journal: UpdateJournal,
): DocumentLifecycle {
  return {
    async ensureDocument(docId) {
      await upsertHead(db, docId);
      const snapshot = await journal.read(docId);
      if (snapshot.checkpoint || snapshot.updates.length > 0) return;

      // The Yjs tables FK to documents.id; callers must create the documents row first.
      const emptyDoc = new Y.Doc({ gc: false });
      await journal.checkpoint(docId, Y.encodeStateAsUpdate(emptyDoc), 0);
    },
  };
}

export function createDrizzleCollabFacadeStore(db: JournalDb): CollabFacadeStore {
  return {
    async createCheckpoint(docId, state, reason, upToSeq) {
      return db.transaction(async (tx) => {
        const checkpointId = await insertCheckpoint(tx as JournalDb, docId, state, upToSeq, reason);
        return String(checkpointId);
      });
    },

    async getCheckpoint(id) {
      const checkpointId = Number(id);
      if (!Number.isSafeInteger(checkpointId)) return null;
      const [row] = await db
        .select()
        .from(documentYjsCheckpoints)
        .where(eq(documentYjsCheckpoints.id, checkpointId))
        .limit(1);
      return row ? mapCheckpoint(row) : null;
    },

    async listCheckpoints(docId) {
      const rows = await db
        .select()
        .from(documentYjsCheckpoints)
        .where(eq(documentYjsCheckpoints.documentId, asDocumentId(docId)))
        .orderBy(desc(documentYjsCheckpoints.id));
      return rows.map(mapCheckpoint);
    },

    async latestUpdate(docId) {
      const [row] = await db
        .select()
        .from(documentYjsUpdates)
        .where(eq(documentYjsUpdates.documentId, asDocumentId(docId)))
        .orderBy(desc(documentYjsUpdates.id))
        .limit(1);
      return row ? mapUpdate(row, "latest") : null;
    },
  };
}

export function createDrizzleCollabPersistence(db: JournalDb): DrizzleCollabPersistence {
  const journal = createDrizzleJournal(db);
  return {
    journal,
    lifecycle: createServerDocumentLifecycle(db, journal),
    store: createDrizzleCollabFacadeStore(db),
  };
}
