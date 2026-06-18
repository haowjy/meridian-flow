import type {
  DocumentId,
  DocumentRestorePointId,
  TurnId,
  UserId,
} from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  documentRestorePoints,
  documents,
  documentYjsCheckpoints,
  documentYjsHeads,
  documentYjsUpdates,
} from "@meridian/database";
import { and, asc, desc, eq, gt, lt, lte, notInArray, sql } from "drizzle-orm";
import type {
  AppendUpdateInput,
  CheckpointRow,
  DocumentStore,
  HeadRow,
  InsertCheckpointInput,
  InsertRestorePointInput,
  RestorePointRow,
  UpdateRow,
} from "../../ports/document-store.js";

type StoreDb = Pick<Database, "select" | "insert" | "update" | "delete" | "transaction">;

const asDocumentId = (value: string) => value as DocumentId;
const restorePointId = (value: string) => value as DocumentRestorePointId;
const userId = (value: string | null) => value as UserId | null;
const turnId = (value: string | null) => value as TurnId | null;

function toBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer);
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

function mapHead(row: typeof documentYjsHeads.$inferSelect, filetype: string): HeadRow {
  return {
    documentId: row.documentId,
    fragmentName: row.fragmentName,
    schemaVersion: row.schemaVersion,
    filetype,
    latestUpdateSeq: row.latestUpdateSeq,
    latestStateVector: row.latestStateVector ? toBytes(row.latestStateVector) : null,
    latestCheckpointId: row.latestCheckpointId,
  };
}

function mapUpdate(row: typeof documentYjsUpdates.$inferSelect): UpdateRow {
  return {
    seq: row.id,
    documentId: row.documentId,
    updateData: toBytes(row.updateData),
    originType: row.originType,
    actorUserId: row.actorUserId,
    actorAgentRunId: row.actorAgentRunId,
    actorTurnId: row.actorTurnId,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapCheckpoint(row: typeof documentYjsCheckpoints.$inferSelect): CheckpointRow {
  return {
    id: row.id,
    documentId: row.documentId,
    state: toBytes(row.state),
    stateVector: toBytes(row.stateVector),
    upToSeq: row.upToSeq,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapRestorePoint(row: typeof documentRestorePoints.$inferSelect): RestorePointRow {
  return {
    id: row.id,
    documentId: row.documentId,
    name: row.name,
    checkpointId: row.checkpointId,
    upToSeq: row.upToSeq,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createDrizzleDocumentStore(db: StoreDb): DocumentStore {
  return {
    async transaction<T>(fn: (store: DocumentStore) => Promise<T>): Promise<T> {
      return db.transaction((tx) => fn(createDrizzleDocumentStore(tx as StoreDb)));
    },

    async getHead(documentId) {
      const [row] = await db
        .select({
          head: documentYjsHeads,
          fileType: documents.fileType,
        })
        .from(documentYjsHeads)
        .innerJoin(documents, eq(documents.id, documentYjsHeads.documentId))
        .where(eq(documentYjsHeads.documentId, asDocumentId(documentId)))
        .limit(1);
      return row ? mapHead(row.head, row.fileType) : null;
    },

    async upsertHead(head) {
      const stateVector = head.latestStateVector ? toBuffer(head.latestStateVector) : null;
      await db
        .insert(documentYjsHeads)
        .values({
          documentId: asDocumentId(head.documentId),
          fragmentName: head.fragmentName,
          schemaVersion: head.schemaVersion,
          latestUpdateSeq: head.latestUpdateSeq,
          latestStateVector: stateVector,
          latestCheckpointId: head.latestCheckpointId,
        })
        .onConflictDoUpdate({
          target: documentYjsHeads.documentId,
          set: {
            fragmentName: head.fragmentName,
            schemaVersion: head.schemaVersion,
            latestUpdateSeq: head.latestUpdateSeq,
            latestStateVector: stateVector,
            latestCheckpointId: head.latestCheckpointId,
            updatedAt: sql`now()`,
          },
        });
    },

    async appendUpdate(input: AppendUpdateInput) {
      const [row] = await db
        .insert(documentYjsUpdates)
        .values({
          documentId: asDocumentId(input.documentId),
          updateData: toBuffer(input.updateData),
          originType: input.originType,
          actorUserId: userId(input.actorUserId),
          actorAgentRunId: input.actorAgentRunId,
          actorTurnId: turnId(input.actorTurnId),
        })
        .returning({ id: documentYjsUpdates.id });
      if (!row) throw new Error("Failed to append Yjs update");
      return row.id;
    },

    async countUpdatesAfter(documentId, afterSeq) {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(documentYjsUpdates)
        .where(
          and(
            eq(documentYjsUpdates.documentId, asDocumentId(documentId)),
            gt(documentYjsUpdates.id, afterSeq),
          ),
        );
      return row?.count ?? 0;
    },

    async listUpdatesAfter(documentId, afterSeq) {
      const rows = await db
        .select()
        .from(documentYjsUpdates)
        .where(
          and(
            eq(documentYjsUpdates.documentId, asDocumentId(documentId)),
            gt(documentYjsUpdates.id, afterSeq),
          ),
        )
        .orderBy(asc(documentYjsUpdates.id));
      return rows.map(mapUpdate);
    },

    async insertCheckpoint(input: InsertCheckpointInput) {
      const [row] = await db
        .insert(documentYjsCheckpoints)
        .values({
          documentId: asDocumentId(input.documentId),
          state: toBuffer(input.state),
          stateVector: toBuffer(input.stateVector),
          upToSeq: input.upToSeq,
          reason: input.reason,
        })
        .returning({ id: documentYjsCheckpoints.id });
      if (!row) throw new Error("Failed to insert checkpoint");
      return row.id;
    },

    async getLatestCheckpoint(documentId) {
      const [row] = await db
        .select()
        .from(documentYjsCheckpoints)
        .where(eq(documentYjsCheckpoints.documentId, asDocumentId(documentId)))
        .orderBy(desc(documentYjsCheckpoints.id))
        .limit(1);
      return row ? mapCheckpoint(row) : null;
    },

    async getCheckpoint(checkpointId) {
      const [row] = await db
        .select()
        .from(documentYjsCheckpoints)
        .where(eq(documentYjsCheckpoints.id, checkpointId))
        .limit(1);
      return row ? mapCheckpoint(row) : null;
    },

    async listCheckpoints(documentId) {
      const rows = await db
        .select()
        .from(documentYjsCheckpoints)
        .where(eq(documentYjsCheckpoints.documentId, asDocumentId(documentId)))
        .orderBy(desc(documentYjsCheckpoints.id));
      return rows.map(mapCheckpoint);
    },

    async insertRestorePoint(input: InsertRestorePointInput) {
      const [row] = await db
        .insert(documentRestorePoints)
        .values({
          documentId: asDocumentId(input.documentId),
          name: input.name,
          checkpointId: input.checkpointId,
          upToSeq: input.upToSeq,
          createdByUserId: userId(input.createdByUserId),
        })
        .returning();
      if (!row) throw new Error("Failed to insert restore point");
      return mapRestorePoint(row);
    },

    async listRestorePoints(documentId) {
      const rows = await db
        .select()
        .from(documentRestorePoints)
        .where(eq(documentRestorePoints.documentId, asDocumentId(documentId)))
        .orderBy(desc(documentRestorePoints.createdAt));
      return rows.map(mapRestorePoint);
    },

    async getRestorePoint(id) {
      const [row] = await db
        .select()
        .from(documentRestorePoints)
        .where(eq(documentRestorePoints.id, restorePointId(id)))
        .limit(1);
      return row ? mapRestorePoint(row) : null;
    },

    async compactDocumentLog(input) {
      await db
        .delete(documentYjsUpdates)
        .where(
          and(
            eq(documentYjsUpdates.documentId, asDocumentId(input.documentId)),
            lte(documentYjsUpdates.id, input.pruneUpdatesThroughSeq),
            lt(documentYjsUpdates.createdAt, new Date(input.pruneRowsCreatedBefore)),
          ),
        );

      const keepPredicate =
        input.keepCheckpointIds.length > 0
          ? notInArray(documentYjsCheckpoints.id, input.keepCheckpointIds)
          : sql`true`;
      await db
        .delete(documentYjsCheckpoints)
        .where(
          and(
            eq(documentYjsCheckpoints.documentId, asDocumentId(input.documentId)),
            lte(documentYjsCheckpoints.upToSeq, input.pruneCheckpointsThroughSeq),
            lt(documentYjsCheckpoints.createdAt, new Date(input.pruneRowsCreatedBefore)),
            keepPredicate,
          ),
        );
    },
  };
}
