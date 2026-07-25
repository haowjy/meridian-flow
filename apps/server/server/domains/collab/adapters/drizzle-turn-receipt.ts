/** Drizzle-backed recovery-state projection for transcript receipt controls. */
import { planRedo, planUndo } from "@meridian/agent-edit/integration";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  agentEditMutations,
  branchWriteJournal,
  documentBranches,
} from "@meridian/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { hasDependentLaterRows } from "../domain/journal-dependencies.js";
import {
  controlForTurnReceiptState,
  type TurnReceiptChip,
  type TurnReceiptState,
  type TurnReceiptStateStore,
} from "../domain/turn-receipt.js";
import { createDrizzleJournal } from "./drizzle-journal.js";

type TurnReceiptDb = Database;

type JournalDependencyRow = {
  id: number;
  branchId: string;
  generation: number;
  updateData: Uint8Array | Buffer;
};

const RECEIPT_PRIORITY: readonly TurnReceiptState[] = [
  "cant_undo_dependent",
  "live-active",
  "live-reversed",
  "branch-active",
  "branch-reversed",
  "rollback-pending",
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
    .selectDistinct({ documentId: agentEditMutations.documentId })
    .from(agentEditMutations)
    .where(and(eq(agentEditMutations.threadId, threadId), eq(agentEditMutations.turnId, turnId)));
  if (rows.length === 0) return [];

  const reversalStore = createDrizzleJournal(db);
  const states = await Promise.all(
    rows.map(async ({ documentId }): Promise<TurnReceiptState> => {
      const selection = { kind: "turn" as const, turnId };
      const undo = await planUndo({
        reversalStore,
        docId: documentId,
        threadId,
        selection,
      });
      if (undo.ok) return "live-active";
      if (undo.status === "cant_undo_dependent") return "cant_undo_dependent";

      const redo = await planRedo({
        reversalStore,
        docId: documentId,
        threadId,
        selection,
      });
      return redo.ok ? "live-reversed" : "expired";
    }),
  );
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
