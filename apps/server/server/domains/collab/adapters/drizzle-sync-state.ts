/** Drizzle adapter for durable agent-edit per-thread sync baselines. */
import type { SyncState, SyncStateStore } from "@meridian/agent-edit";
import type { Database } from "@meridian/database";
import { agentEditSyncState } from "@meridian/database";
import { sql } from "drizzle-orm";
import {
  LIVE_SCOPE,
  scopedConflictTarget,
  scopedValues,
  scopedWhere,
} from "./drizzle-agent-edit-scope";

type SyncStateDb = Pick<Database, "select" | "insert" | "delete">;

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
          syncedSnapshot: agentEditSyncState.syncedSnapshot,
          committedSnapshot: agentEditSyncState.committedSnapshot,
          hasKnownFullContent: agentEditSyncState.hasKnownFullContent,
        })
        .from(agentEditSyncState)
        .where(scopedWhere(agentEditSyncState, { documentId, threadId, scopeId: LIVE_SCOPE }))
        .limit(1);
      if (!row) return null;
      return {
        stateVector: toBytes(row.stateVector),
        syncedSnapshot: toBytes(row.syncedSnapshot),
        committedSnapshot: toBytes(row.committedSnapshot),
        hasKnownFullContent: row.hasKnownFullContent,
      };
    },

    async save(documentId, threadId, state): Promise<void> {
      await db
        .insert(agentEditSyncState)
        .values({
          ...scopedValues({ documentId, threadId, scopeId: LIVE_SCOPE }),
          stateVector: toBuffer(state.stateVector),
          syncedSnapshot: toBuffer(state.syncedSnapshot),
          committedSnapshot: toBuffer(state.committedSnapshot),
          hasKnownFullContent: state.hasKnownFullContent,
        })
        .onConflictDoUpdate({
          target: scopedConflictTarget(agentEditSyncState),
          set: {
            stateVector: toBuffer(state.stateVector),
            syncedSnapshot: toBuffer(state.syncedSnapshot),
            committedSnapshot: toBuffer(state.committedSnapshot),
            hasKnownFullContent: state.hasKnownFullContent,
            updatedAt: sql`now()`,
          },
        });
    },

    async delete(documentId, threadId): Promise<void> {
      await db
        .delete(agentEditSyncState)
        .where(scopedWhere(agentEditSyncState, { documentId, threadId, scopeId: LIVE_SCOPE }));
    },
  };
}
