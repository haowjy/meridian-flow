/** Drizzle helpers for server-only collab domain lifecycle operations. */
import type {
  DocumentLifecycle,
  PersistedUpdate,
  UpdateJournal,
  UpdateMeta,
} from "@meridian/agent-edit";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentYjsCheckpoints, documentYjsHeads, documentYjsUpdates } from "@meridian/database";
import { desc, eq, sql } from "drizzle-orm";
import * as Y from "yjs";

export type FacadeCheckpointRecord = {
  id: string;
  documentId: string;
  state: Uint8Array;
  reason: string;
  createdAt: string;
};

export type CollabFacadeStore = {
  createCheckpoint(docId: string, state: Uint8Array, reason: string): Promise<string>;
  getCheckpoint(id: string): Promise<FacadeCheckpointRecord | null>;
  listCheckpoints(docId: string): Promise<FacadeCheckpointRecord[]>;
  latestUpdate(docId: string): Promise<PersistedUpdate | null>;
};

type FacadeDb = Pick<Database, "select" | "insert" | "update" | "transaction">;

const asDocumentId = (value: string) => value as DocumentId;

function toBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer);
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

async function maxUpdateSeq(db: FacadeDb, documentId: string): Promise<number> {
  const [row] = await db
    .select({ maxSeq: sql<number>`coalesce(max(${documentYjsUpdates.id}), 0)` })
    .from(documentYjsUpdates)
    .where(eq(documentYjsUpdates.documentId, asDocumentId(documentId)));
  return row?.maxSeq ?? 0;
}

async function upsertHead(
  db: FacadeDb,
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

function metaFromRow(row: typeof documentYjsUpdates.$inferSelect): UpdateMeta {
  if (row.originType === "agent" && row.actorTurnId) {
    return { origin: `agent:${row.actorTurnId}`, actorTurnId: row.actorTurnId, seq: row.id };
  }
  if ((row.originType === "human" || row.originType === "user") && row.actorUserId) {
    return {
      origin: `human:${row.actorUserId}`,
      ...(row.actorTurnId ? { actorTurnId: row.actorTurnId } : {}),
      seq: row.id,
    };
  }
  return {
    origin: "system",
    ...(row.actorTurnId ? { actorTurnId: row.actorTurnId } : {}),
    seq: row.id,
  };
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

export function createServerDocumentLifecycle(
  db: FacadeDb,
  journal: UpdateJournal,
): DocumentLifecycle {
  return {
    async ensureDocument(docId) {
      await upsertHead(db, docId);
      const snapshot = await journal.read(docId);
      if (snapshot.checkpoint || snapshot.updates.length > 0) return;

      // The Yjs tables FK to documents.id; callers must create the documents row first.
      const emptyDoc = new Y.Doc({ gc: false });
      await journal.checkpoint(docId, Y.encodeStateAsUpdate(emptyDoc));
    },
  };
}

export function createDrizzleCollabFacadeStore(db: FacadeDb): CollabFacadeStore {
  return {
    async createCheckpoint(docId, state, reason) {
      return db.transaction(async (tx) => {
        const txDb = tx as FacadeDb;
        const upToSeq = await maxUpdateSeq(txDb, docId);
        const stateVector = Y.encodeStateVectorFromUpdate(state);
        const [row] = await txDb
          .insert(documentYjsCheckpoints)
          .values({
            documentId: asDocumentId(docId),
            state: toBuffer(state),
            stateVector: toBuffer(stateVector),
            upToSeq,
            reason,
          })
          .returning({ id: documentYjsCheckpoints.id });
        if (!row) throw new Error("Failed to insert Yjs checkpoint");
        await upsertHead(txDb, docId, {
          latestUpdateSeq: upToSeq,
          latestStateVector: stateVector,
          latestCheckpointId: row.id,
        });
        return String(row.id);
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
      if (!row) return null;
      return { seq: row.id, update: toBytes(row.updateData), meta: metaFromRow(row) };
    },
  };
}
