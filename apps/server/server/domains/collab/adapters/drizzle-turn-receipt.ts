/** Drizzle read-model for server-derived transcript receipt chip states. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  agentEditMutations,
  branchWriteJournal,
  documentYjsReversals,
} from "@meridian/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  controlForTurnReceiptState,
  type TurnReceiptChip,
  type TurnReceiptStateStore,
} from "../domain/turn-receipt.js";
import { LIVE_SCOPE } from "./drizzle-agent-edit-scope.js";

type TurnReceiptDb = Pick<Database, "select">;

type StatusCount = { status: string; count: number };

export function createDrizzleTurnReceiptStore(db: TurnReceiptDb): TurnReceiptStateStore {
  return {
    async getTurnReceiptChip(threadId, turnId) {
      const state =
        (await liveState(db, threadId, turnId)) ?? (await branchState(db, threadId, turnId));
      return state
        ? ({ state, control: controlForTurnReceiptState(state) } satisfies TurnReceiptChip)
        : null;
    },
  };
}

async function liveState(db: TurnReceiptDb, threadId: ThreadId, turnId: TurnId) {
  const rows = await db
    .select({ status: documentYjsReversals.status, count: sql<number>`count(*)::int` })
    .from(agentEditMutations)
    .innerJoin(
      documentYjsReversals,
      and(
        eq(documentYjsReversals.documentId, agentEditMutations.documentId),
        eq(documentYjsReversals.threadId, agentEditMutations.threadId),
        eq(documentYjsReversals.writeId, agentEditMutations.writeId),
        eq(documentYjsReversals.scopeId, LIVE_SCOPE),
      ),
    )
    .where(
      and(
        eq(agentEditMutations.threadId, threadId),
        eq(agentEditMutations.turnId, turnId),
        eq(agentEditMutations.scopeId, LIVE_SCOPE),
      ),
    )
    .groupBy(documentYjsReversals.status);
  if (rows.length === 0) {
    const [liveWrites] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentEditMutations)
      .where(
        and(
          eq(agentEditMutations.threadId, threadId),
          eq(agentEditMutations.turnId, turnId),
          eq(agentEditMutations.scopeId, LIVE_SCOPE),
        ),
      );
    return (liveWrites?.count ?? 0) > 0 ? "live-active" : null;
  }
  return stateFromLiveCounts(rows);
}

function stateFromLiveCounts(rows: readonly StatusCount[]) {
  const statuses = new Set(rows.map((row) => row.status));
  if (statuses.has("expired")) return "expired" as const;
  if (statuses.has("reversed")) return "live-reversed" as const;
  return "live-active" as const;
}

async function branchState(db: TurnReceiptDb, threadId: ThreadId, turnId: TurnId) {
  const rows = await db
    .select({ status: branchWriteJournal.status, count: sql<number>`count(*)::int` })
    .from(branchWriteJournal)
    .where(and(eq(branchWriteJournal.threadId, threadId), eq(branchWriteJournal.turnId, turnId)))
    .groupBy(branchWriteJournal.status);
  if (rows.length === 0) return null;
  const statuses = new Set(rows.map((row) => row.status));
  if (statuses.has("rollback_pending")) return "rollback-pending" as const;
  if (statuses.has("active")) {
    const dependent = await hasLaterActiveBranchRows(db, threadId, turnId);
    return dependent ? "cant_undo_dependent" : ("branch-active" as const);
  }
  if (statuses.has("discarded")) return "branch-reversed" as const;
  return "live-active" as const;
}

async function hasLaterActiveBranchRows(db: TurnReceiptDb, threadId: ThreadId, turnId: TurnId) {
  const [maxSelected] = await db
    .select({ id: sql<number>`max(${branchWriteJournal.id})::int` })
    .from(branchWriteJournal)
    .where(
      and(
        eq(branchWriteJournal.threadId, threadId),
        eq(branchWriteJournal.turnId, turnId),
        inArray(branchWriteJournal.status, ["active", "rollback_pending"]),
      ),
    );
  if (!maxSelected?.id) return false;
  const [later] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(branchWriteJournal)
    .where(
      and(
        sql`${branchWriteJournal.id} > ${maxSelected.id}`,
        eq(branchWriteJournal.status, "active"),
      ),
    );
  return (later?.count ?? 0) > 0;
}
