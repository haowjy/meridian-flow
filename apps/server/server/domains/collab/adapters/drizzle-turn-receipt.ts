/** Drizzle read-model for server-derived transcript receipt chip states. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  agentEditMutations,
  branchWriteJournal,
  documentBranches,
  documentYjsReversals,
} from "@meridian/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { hasDependentLaterRows } from "../domain/journal-dependencies.js";
import {
  controlForTurnReceiptState,
  type TurnReceiptChip,
  type TurnReceiptState,
  type TurnReceiptStateStore,
} from "../domain/turn-receipt.js";

type TurnReceiptDb = Pick<Database, "select">;

type StatusCount = { status: string; count: number };
type JournalDependencyRow = {
  id: number;
  branchId: string;
  generation: number;
  updateData: Uint8Array | Buffer;
};

const RECEIPT_PRIORITY: readonly TurnReceiptState[] = [
  "live-active",
  "live-reversed",
  "branch-active",
  "branch-reversed",
  "rollback-pending",
  "cant_undo_dependent",
  "expired",
];

export function selectTurnReceiptState(
  candidates: readonly TurnReceiptState[],
): TurnReceiptState | undefined {
  return RECEIPT_PRIORITY.find((candidate) => candidates.includes(candidate));
}

export function createDrizzleTurnReceiptStore(db: TurnReceiptDb): TurnReceiptStateStore {
  return {
    async getTurnReceiptChip(threadId, turnId) {
      const candidates = [
        ...(await liveStates(db, threadId, turnId)),
        ...(await branchStates(db, threadId, turnId)),
      ];
      const state = selectTurnReceiptState(candidates);
      return state
        ? ({ state, control: controlForTurnReceiptState(state) } satisfies TurnReceiptChip)
        : null;
    },
  };
}

async function liveStates(
  db: TurnReceiptDb,
  threadId: ThreadId,
  turnId: TurnId,
): Promise<TurnReceiptState[]> {
  const rows = await db
    .select({ status: documentYjsReversals.status, count: sql<number>`count(*)::int` })
    .from(agentEditMutations)
    .innerJoin(
      documentYjsReversals,
      and(
        eq(documentYjsReversals.documentId, agentEditMutations.documentId),
        eq(documentYjsReversals.threadId, agentEditMutations.threadId),
        eq(documentYjsReversals.writeId, agentEditMutations.writeId),
      ),
    )
    .where(and(eq(agentEditMutations.threadId, threadId), eq(agentEditMutations.turnId, turnId)))
    .groupBy(documentYjsReversals.status);
  if (rows.length === 0) {
    const [liveWrites] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentEditMutations)
      .where(and(eq(agentEditMutations.threadId, threadId), eq(agentEditMutations.turnId, turnId)));
    return (liveWrites?.count ?? 0) > 0 ? ["live-active"] : [];
  }
  return statesFromLiveCounts(rows);
}

function statesFromLiveCounts(rows: readonly StatusCount[]): TurnReceiptState[] {
  const statuses = new Set(rows.map((row) => row.status));
  const states: TurnReceiptState[] = [];
  if (statuses.has("reversed")) states.push("live-reversed");
  if ([...statuses].some((status) => status !== "reversed" && status !== "expired")) {
    states.push("live-active");
  }
  if (statuses.has("expired")) states.push("expired");
  return states;
}

async function branchStates(
  db: TurnReceiptDb,
  threadId: ThreadId,
  turnId: TurnId,
): Promise<TurnReceiptState[]> {
  const currentRows = await db
    .select({ status: branchWriteJournal.status, count: sql<number>`count(*)::int` })
    .from(branchWriteJournal)
    .innerJoin(documentBranches, eq(branchWriteJournal.branchId, documentBranches.id))
    .where(
      and(
        eq(branchWriteJournal.threadId, threadId),
        eq(branchWriteJournal.turnId, turnId),
        eq(documentBranches.status, "active"),
        eq(branchWriteJournal.generation, documentBranches.generation),
      ),
    )
    .groupBy(branchWriteJournal.status);

  const states: TurnReceiptState[] = [];
  const statuses = new Set(currentRows.map((row) => row.status));
  if (statuses.has("active")) {
    states.push(
      (await hasLaterActiveBranchRows(db, threadId, turnId))
        ? "cant_undo_dependent"
        : "branch-active",
    );
  }
  if (statuses.has("discarded")) states.push("branch-reversed");
  if (statuses.has("rollback_pending")) states.push("rollback-pending");
  if (states.length > 0) return states;

  const [historical] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(branchWriteJournal)
    .where(and(eq(branchWriteJournal.threadId, threadId), eq(branchWriteJournal.turnId, turnId)));
  return (historical?.count ?? 0) > 0 ? ["expired"] : [];
}

async function hasLaterActiveBranchRows(db: TurnReceiptDb, threadId: ThreadId, turnId: TurnId) {
  const selectedRows = await db
    .select({
      id: branchWriteJournal.id,
      branchId: branchWriteJournal.branchId,
      generation: branchWriteJournal.generation,
      updateData: branchWriteJournal.updateData,
    })
    .from(branchWriteJournal)
    .innerJoin(documentBranches, eq(branchWriteJournal.branchId, documentBranches.id))
    .where(
      and(
        eq(branchWriteJournal.threadId, threadId),
        eq(branchWriteJournal.turnId, turnId),
        inArray(branchWriteJournal.status, ["active", "rollback_pending"]),
        eq(documentBranches.status, "active"),
        eq(branchWriteJournal.generation, documentBranches.generation),
      ),
    );
  if (selectedRows.length === 0) return false;

  for (const [branchKey, rows] of groupDependencyRows(selectedRows)) {
    const [branchId, generationText] = branchKey.split(":");
    const generation = Number(generationText);
    const maxSelectedId = Math.max(...rows.map((row) => row.id));
    const laterRows = await db
      .select({
        id: branchWriteJournal.id,
        branchId: branchWriteJournal.branchId,
        generation: branchWriteJournal.generation,
        updateData: branchWriteJournal.updateData,
      })
      .from(branchWriteJournal)
      .where(
        and(
          eq(branchWriteJournal.branchId, branchId as string),
          eq(branchWriteJournal.generation, generation),
          sql`${branchWriteJournal.id} > ${maxSelectedId}`,
          eq(branchWriteJournal.status, "active"),
        ),
      );
    if (hasDependentLaterRows(rows, laterRows)) return true;
  }
  return false;
}

function groupDependencyRows(
  rows: readonly JournalDependencyRow[],
): Map<string, JournalDependencyRow[]> {
  const groups = new Map<string, JournalDependencyRow[]>();
  for (const row of rows) {
    const key = `${row.branchId}:${row.generation}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}
