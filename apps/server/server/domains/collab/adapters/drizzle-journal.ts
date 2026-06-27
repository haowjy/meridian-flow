/** Drizzle-backed collab persistence for Yjs updates, checkpoints, and lifecycle. */

import type {
  ActiveWriteSummary,
  DocumentLifecycle,
  JournalReadOptions,
  JournalSnapshot,
  PersistedUpdate,
  ReversalActor,
  ReversalRecord,
  ReversalStatus,
  ReversalStore,
  UpdateJournal,
  UpdateMeta,
  WriteMutationRow,
} from "@meridian/agent-edit";
import { parseWriteHandle, writeHandle } from "@meridian/agent-edit";
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
import { COLLAB_SCHEMA_VERSION, createCollabYDoc } from "@meridian/prosemirror-schema";
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, ne, or, sql } from "drizzle-orm";
import * as Y from "yjs";
import { isStaleSchema, StaleDocumentSchemaError } from "../domain/stale-schema.js";

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
  journal: UpdateJournal & ReversalStore;
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
    writeIds: row.writeId ? [row.writeId] : [row.turnId],
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

async function latestBaselineCheckpoint(db: JournalDb, documentId: string) {
  const [row] = await db
    .select()
    .from(documentYjsCheckpoints)
    .where(
      and(
        eq(documentYjsCheckpoints.documentId, asDocumentId(documentId)),
        eq(documentYjsCheckpoints.upToSeq, 0),
      ),
    )
    .orderBy(desc(documentYjsCheckpoints.id))
    .limit(1);
  return row ?? null;
}

async function readHeadSchemaVersion(db: JournalDb, documentId: string): Promise<number | null> {
  const [row] = await db
    .select({ schemaVersion: documentYjsHeads.schemaVersion })
    .from(documentYjsHeads)
    .where(eq(documentYjsHeads.documentId, asDocumentId(documentId)))
    .limit(1);
  return row?.schemaVersion ?? null;
}

function assertHeadSchemaCurrent(docId: string, storedVersion: number | null): void {
  if (storedVersion !== null && isStaleSchema(storedVersion, COLLAB_SCHEMA_VERSION)) {
    throw new StaleDocumentSchemaError(docId, storedVersion, COLLAB_SCHEMA_VERSION);
  }
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
      schemaVersion: COLLAB_SCHEMA_VERSION,
      latestUpdateSeq: input.latestUpdateSeq ?? 0,
      latestStateVector: input.latestStateVector ? toBuffer(input.latestStateVector) : null,
      latestCheckpointId: input.latestCheckpointId ?? null,
    })
    .onConflictDoUpdate({
      target: documentYjsHeads.documentId,
      set: {
        schemaVersion: COLLAB_SCHEMA_VERSION,
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

async function reserveWriteOrdinal(
  db: JournalDb,
  input: { documentId: string; threadId: string },
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
      set: { nextWid: sql`${agentEditWidCounters.nextWid} + 1` },
    })
    .returning({ wId: agentEditWidCounters.nextWid });
  if (!counter) throw new Error("Failed to allocate agent edit w-id");
  return counter.wId;
}

async function reverseMutationsForWrite(
  db: JournalDb,
  input: {
    documentId: string;
    threadId: string;
    writeId: string;
    undoUpdateSeq: number;
    at: Date;
    actor: ReversalActor;
  },
): Promise<void> {
  // Reversal records carry write handles ("w3"); the writeId text column stores
  // the durable id (tool_use_id/UUID), so match on the wId ordinal like every
  // other lookup in this adapter.
  const ordinal = parseWriteHandle(input.writeId);
  if (ordinal === undefined) return;
  await db
    .update(agentEditMutations)
    .set({
      status: "reversed",
      undoUpdateSeq: input.undoUpdateSeq,
      reversedAt: input.at,
      reversedBy: input.actor.type,
    })
    .where(
      and(
        eq(agentEditMutations.documentId, asDocumentId(input.documentId)),
        eq(agentEditMutations.threadId, asThreadId(input.threadId)),
        eq(agentEditMutations.wId, ordinal),
        eq(agentEditMutations.status, "active"),
      ),
    );
}

async function reactivateMutationsForWrite(
  db: JournalDb,
  input: { documentId: string; threadId: string; writeId: string; undoUpdateSeq: number },
): Promise<void> {
  // writeId here is a handle ("w3"); match on the wId ordinal (see reverseMutationsForWrite).
  const ordinal = parseWriteHandle(input.writeId);
  if (ordinal === undefined) return;
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
        eq(agentEditMutations.wId, ordinal),
        eq(agentEditMutations.status, "reversed"),
        eq(agentEditMutations.undoUpdateSeq, input.undoUpdateSeq),
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

function mapActiveWrite(row: {
  writeId: string;
  wId: number;
  turnId: string;
  createdSeq: number;
}): ActiveWriteSummary {
  return {
    writeId: row.writeId,
    handle: writeHandle(row.wId),
    wId: row.wId,
    turnId: row.turnId,
    createdSeq: Number(row.createdSeq),
  };
}

function mapWriteMutationRow(row: {
  writeId: string;
  wId: number;
  turnId: string;
  createdSeq: number;
  status: "active" | "reversed";
  undoUpdateSeq: number | null;
}): WriteMutationRow {
  return {
    writeId: row.writeId,
    handle: writeHandle(row.wId),
    wId: row.wId,
    turnId: row.turnId,
    createdSeq: Number(row.createdSeq),
    status: row.status,
    ...(row.undoUpdateSeq === null ? {} : { undoUpdateSeq: Number(row.undoUpdateSeq) }),
  };
}

export function createDrizzleJournal(db: JournalDb): UpdateJournal & ReversalStore {
  return {
    async append(docId, update, meta) {
      return appendUpdate(db, docId, update, meta);
    },

    async appendBatch(entries) {
      if (entries.length === 0) return [];
      return db.transaction(async (tx) => {
        const txDb = tx as JournalDb;

        // Multi-row INSERT for all updates — one round-trip instead of N.
        const updateRows = await txDb
          .insert(documentYjsUpdates)
          .values(
            entries.map((entry) => {
              const origin = parseOrigin(entry.meta);
              return {
                documentId: asDocumentId(entry.docId),
                updateData: toBuffer(entry.update),
                originType: origin.originType,
                actorUserId: origin.actorUserId ?? null,
                actorTurnId: origin.actorTurnId ?? null,
              };
            }),
          )
          .returning({ id: documentYjsUpdates.id });

        // PostgreSQL returning order matches insertion order for a single
        // INSERT, but sort by id to be safe (id is auto-incrementing).
        updateRows.sort((a, b) => a.id - b.id);

        // Reserve wIds for mutations that don't have one pre-allocated.
        const mutationValues: Array<{
          index: number;
          seq: number;
          wId: number;
          threadId: string;
          turnId: string;
          writeId: string;
          docId: string;
        }> = [];
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          if (!entry.mutation) continue;
          const seq = updateRows[i].id;
          const wId =
            entry.mutation.wId ??
            (await reserveWriteOrdinal(txDb, {
              documentId: entry.docId,
              threadId: entry.mutation.threadId,
            }));
          mutationValues.push({
            index: i,
            seq,
            wId,
            threadId: entry.mutation.threadId,
            turnId: entry.mutation.turnId,
            writeId:
              entry.mutation.writeId ??
              `${entry.mutation.threadId}:${entry.mutation.turnId}:${seq}`,
            docId: entry.docId,
          });
        }

        // Multi-row INSERT for all mutations — one round-trip instead of N.
        if (mutationValues.length > 0) {
          await txDb.insert(agentEditMutations).values(
            mutationValues.map((mv) => ({
              wId: mv.wId,
              documentId: asDocumentId(mv.docId),
              threadId: asThreadId(mv.threadId),
              turnId: asTurnId(mv.turnId),
              writeId: mv.writeId,
              status: "active" as const,
              createdSeq: mv.seq,
            })),
          );
        }

        // Build results aligned with entries order.
        const results: Array<{ seq: number; wId?: number }> = [];
        let mutIdx = 0;
        for (let i = 0; i < entries.length; i++) {
          const seq = updateRows[i].id;
          const mv = mutationValues[mutIdx];
          if (mv && mv.index === i) {
            results.push({ seq, wId: mv.wId });
            mutIdx += 1;
          } else {
            results.push({ seq });
          }
        }
        return results;
      });
    },

    async reserveWriteOrdinal(documentId, threadId) {
      return reserveWriteOrdinal(db, { documentId, threadId });
    },

    async latestActiveWrite(documentId, threadId) {
      const [row] = await db
        .select({
          writeId: agentEditMutations.writeId,
          wId: agentEditMutations.wId,
          turnId: agentEditMutations.turnId,
          createdSeq: agentEditMutations.createdSeq,
        })
        .from(agentEditMutations)
        .where(
          and(
            eq(agentEditMutations.documentId, asDocumentId(documentId)),
            eq(agentEditMutations.threadId, asThreadId(threadId)),
            eq(agentEditMutations.status, "active"),
          ),
        )
        .orderBy(desc(agentEditMutations.wId))
        .limit(1);
      return row ? mapActiveWrite(row) : undefined;
    },

    async activeWriteSummary(documentId, threadId) {
      const rows = await db
        .select({
          writeId: agentEditMutations.writeId,
          wId: agentEditMutations.wId,
          turnId: agentEditMutations.turnId,
          createdSeq: agentEditMutations.createdSeq,
        })
        .from(agentEditMutations)
        .where(
          and(
            eq(agentEditMutations.documentId, asDocumentId(documentId)),
            eq(agentEditMutations.threadId, asThreadId(threadId)),
            eq(agentEditMutations.status, "active"),
          ),
        )
        .orderBy(asc(agentEditMutations.wId));
      return rows.map(mapActiveWrite);
    },

    async writeMinCreatedSeq(documentId, threadId, handle) {
      const ordinal = parseWriteHandle(handle);
      if (ordinal === undefined) return undefined;
      const [row] = await db
        .select({ minSeq: sql<number>`min(${agentEditMutations.createdSeq})` })
        .from(agentEditMutations)
        .where(
          and(
            eq(agentEditMutations.documentId, asDocumentId(documentId)),
            eq(agentEditMutations.threadId, asThreadId(threadId)),
            eq(agentEditMutations.wId, ordinal),
          ),
        );
      return row?.minSeq === null || row?.minSeq === undefined ? undefined : Number(row.minSeq);
    },

    async mutationsForWrite(documentId, threadId, handle): Promise<WriteMutationRow[]> {
      const ordinal = parseWriteHandle(handle);
      if (ordinal === undefined) return [];
      const rows = await db
        .select({
          writeId: agentEditMutations.writeId,
          wId: agentEditMutations.wId,
          turnId: agentEditMutations.turnId,
          createdSeq: agentEditMutations.createdSeq,
          status: agentEditMutations.status,
          undoUpdateSeq: agentEditMutations.undoUpdateSeq,
        })
        .from(agentEditMutations)
        .where(
          and(
            eq(agentEditMutations.documentId, asDocumentId(documentId)),
            eq(agentEditMutations.threadId, asThreadId(threadId)),
            eq(agentEditMutations.wId, ordinal),
          ),
        )
        .orderBy(asc(agentEditMutations.createdSeq), asc(agentEditMutations.wId));

      return rows.map(mapWriteMutationRow);
    },

    async mutationsForWrites(
      documentId,
      threadId,
      handles,
    ): Promise<Map<string, WriteMutationRow[]>> {
      const ordinals = handles
        .map((h) => parseWriteHandle(h))
        .filter((o): o is number => o !== undefined);
      const result = new Map<string, WriteMutationRow[]>();
      if (ordinals.length === 0) return result;
      const rows = await db
        .select({
          writeId: agentEditMutations.writeId,
          wId: agentEditMutations.wId,
          turnId: agentEditMutations.turnId,
          createdSeq: agentEditMutations.createdSeq,
          status: agentEditMutations.status,
          undoUpdateSeq: agentEditMutations.undoUpdateSeq,
        })
        .from(agentEditMutations)
        .where(
          and(
            eq(agentEditMutations.documentId, asDocumentId(documentId)),
            eq(agentEditMutations.threadId, asThreadId(threadId)),
            inArray(agentEditMutations.wId, ordinals),
          ),
        )
        .orderBy(asc(agentEditMutations.createdSeq), asc(agentEditMutations.wId));

      for (const row of rows) {
        const handle = writeHandle(row.wId);
        const mapped = mapWriteMutationRow(row);
        const existing = result.get(handle);
        if (existing) existing.push(mapped);
        else result.set(handle, [mapped]);
      }
      return result;
    },

    async read(
      docId,
      opts: JournalReadOptions & { fromCheckpoint?: boolean } = {},
    ): Promise<JournalSnapshot> {
      assertHeadSchemaCurrent(docId, await readHeadSchemaVersion(db, docId));

      const latest = await latestCheckpoint(db, docId);
      const fromCheckpoint = opts.fromCheckpoint ?? true;
      const conditions = [eq(documentYjsUpdates.documentId, asDocumentId(docId))];
      if (fromCheckpoint) conditions.push(gt(documentYjsUpdates.id, latest?.upToSeq ?? 0));
      if (opts.since !== undefined) conditions.push(gte(documentYjsUpdates.id, opts.since));
      if (opts.until !== undefined) conditions.push(lte(documentYjsUpdates.id, opts.until));

      const rows = await db
        .select()
        .from(documentYjsUpdates)
        .where(and(...conditions))
        .orderBy(asc(documentYjsUpdates.id));

      const checkpoint = fromCheckpoint ? latest : await latestBaselineCheckpoint(db, docId);
      return {
        checkpoint: checkpoint ? toBytes(checkpoint.state) : null,
        updates: rows.map((row) => mapUpdate(row)),
      };
    },

    async readForReconstruction(docId: string): Promise<JournalSnapshot> {
      return (
        this.read as (
          docId: string,
          opts: JournalReadOptions & { fromCheckpoint?: boolean },
        ) => Promise<JournalSnapshot>
      )(docId, { fromCheckpoint: false });
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
          const doc = createCollabYDoc({ gc: false });
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

    async persistUndo(docId, undoUpdate, records, actor = { type: "agent" }) {
      let undoUpdateSeq: number | undefined;
      await db.transaction(async (tx) => {
        const txDb = tx as JournalDb;
        undoUpdateSeq = await appendUpdate(txDb, docId, undoUpdate, { origin: "system", seq: 0 });
        for (const record of records) {
          for (const writeId of record.writeIds) {
            await txDb
              .insert(documentYjsReversals)
              .values({
                documentId: asDocumentId(docId),
                threadId: asThreadId(record.threadId),
                turnId: asTurnId(record.turnId),
                writeId,
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
                  documentYjsReversals.writeId,
                ],
                set: {
                  status: record.status,
                  undoUpdateSeq,
                  expiresAt: record.expiresAt ?? null,
                  reversedAt: record.reversedAt ?? null,
                  reversedByUserId: asUserId(record.reversedByUserId) ?? null,
                },
              });
          }
          for (const writeId of record.writeIds) {
            await reverseMutationsForWrite(txDb, {
              documentId: docId,
              threadId: record.threadId,
              writeId,
              undoUpdateSeq,
              at: record.reversedAt ?? new Date(),
              actor,
            });
          }
        }
      });
      if (undoUpdateSeq === undefined) throw new Error("Failed to persist reversal update");
      for (const record of records) record.undoUpdateSeq = undoUpdateSeq;
    },

    async persistRedo(docId, redoUpdate, ref, meta) {
      return db.transaction(async (tx) => {
        const txDb = tx as JournalDb;
        const reversals = await txDb
          .select({ writeId: documentYjsReversals.writeId, status: documentYjsReversals.status })
          .from(documentYjsReversals)
          .where(
            and(
              eq(documentYjsReversals.documentId, asDocumentId(docId)),
              eq(documentYjsReversals.threadId, asThreadId(ref.threadId)),
              eq(documentYjsReversals.undoUpdateSeq, ref.undoUpdateSeq),
            ),
          )
          .for("update");

        if (reversals.length === 0 || reversals.some((row) => row.status !== "reversed")) {
          return { consumed: false };
        }

        const seq = await appendUpdate(txDb, docId, redoUpdate, meta);
        await txDb
          .update(documentYjsReversals)
          .set({ status: "redone" })
          .where(
            and(
              eq(documentYjsReversals.documentId, asDocumentId(docId)),
              eq(documentYjsReversals.threadId, asThreadId(ref.threadId)),
              eq(documentYjsReversals.undoUpdateSeq, ref.undoUpdateSeq),
            ),
          );
        for (const reversal of reversals) {
          await reactivateMutationsForWrite(txDb, {
            documentId: docId,
            threadId: ref.threadId,
            writeId: reversal.writeId,
            undoUpdateSeq: ref.undoUpdateSeq,
          });
        }

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
      const snapshot = await journal.read(docId);
      if (snapshot.checkpoint || snapshot.updates.length > 0) return;

      await upsertHead(db, docId);

      // The Yjs tables FK to documents.id; callers must create the documents row first.
      const emptyDoc = createCollabYDoc({ gc: false });
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
