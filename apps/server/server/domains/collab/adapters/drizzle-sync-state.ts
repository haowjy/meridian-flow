/** Drizzle adapter for durable agent-edit per-thread sync baselines. */
import type { SyncState, SyncStateStore } from "@meridian/agent-edit";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { agentEditSyncState } from "@meridian/database";
import { and, eq, sql } from "drizzle-orm";

type SyncStateDb = Pick<Database, "select" | "insert" | "delete">;

const asDocumentId = (value: string) => value as DocumentId;
const asThreadId = (value: string) => value as ThreadId;

function toBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer);
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

export function createDrizzleSyncStateStore(db: SyncStateDb): SyncStateStore {
  return {
    async load(documentId, threadId): Promise<SyncState | null> {
      const [row] = await db
        .select({
          stateVector: agentEditSyncState.stateVector,
          committedSnapshot: agentEditSyncState.committedSnapshot,
        })
        .from(agentEditSyncState)
        .where(
          and(
            eq(agentEditSyncState.documentId, asDocumentId(documentId)),
            eq(agentEditSyncState.threadId, asThreadId(threadId)),
          ),
        )
        .limit(1);
      if (!row) return null;
      return {
        stateVector: toBytes(row.stateVector),
        committedSnapshot: toBytes(row.committedSnapshot),
      };
    },

    async save(documentId, threadId, state): Promise<void> {
      await db
        .insert(agentEditSyncState)
        .values({
          documentId: asDocumentId(documentId),
          threadId: asThreadId(threadId),
          stateVector: toBuffer(state.stateVector),
          committedSnapshot: toBuffer(state.committedSnapshot),
        })
        .onConflictDoUpdate({
          target: [agentEditSyncState.documentId, agentEditSyncState.threadId],
          set: {
            stateVector: toBuffer(state.stateVector),
            committedSnapshot: toBuffer(state.committedSnapshot),
            updatedAt: sql`now()`,
          },
        });
    },

    async delete(documentId, threadId): Promise<void> {
      await db
        .delete(agentEditSyncState)
        .where(
          and(
            eq(agentEditSyncState.documentId, asDocumentId(documentId)),
            eq(agentEditSyncState.threadId, asThreadId(threadId)),
          ),
        );
    },
  };
}
