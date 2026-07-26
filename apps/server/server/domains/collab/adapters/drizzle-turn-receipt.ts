/** Drizzle-backed recovery-state projection for transcript receipt controls. */
import { planRedo, planUndo } from "@meridian/agent-edit/integration";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  agentEditMutations,
  branchWriteJournal,
  documentBranches,
} from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import type { BranchSnapshot } from "../domain/branch-coordinator.js";
import type { BranchJournalRow } from "../domain/branch-push-contracts.js";
import { createBranchTurnReversalPlanner } from "../domain/branch-turn-reversal-plan.js";
import {
  controlForTurnReceiptState,
  type TurnReceiptChip,
  type TurnReceiptState,
  type TurnReceiptStateStore,
} from "../domain/turn-receipt.js";
import { createDrizzleBranchJournalReadStore } from "./drizzle-branch-push.js";
import { createDrizzleJournal } from "./drizzle-journal.js";

type TurnReceiptDb = Database;

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
    .select({
      journalStatus: branchWriteJournal.status,
      branchId: documentBranches.id,
      documentId: documentBranches.documentId,
      kind: documentBranches.kind,
      upstreamBranchId: documentBranches.upstreamBranchId,
      workId: documentBranches.workId,
      threadId: documentBranches.threadId,
      pushPolicy: documentBranches.pushPolicy,
      status: documentBranches.status,
      generation: documentBranches.generation,
      state: documentBranches.state,
      stateVector: documentBranches.stateVector,
      discardedStateVector: documentBranches.discardedStateVector,
      schemaVersion: documentBranches.schemaVersion,
    })
    .from(branchWriteJournal)
    .innerJoin(documentBranches, eq(branchWriteJournal.branchId, documentBranches.id))
    .where(
      and(
        eq(branchWriteJournal.threadId, threadId),
        eq(branchWriteJournal.turnId, turnId),
        eq(documentBranches.status, "active"),
        eq(branchWriteJournal.generation, documentBranches.generation),
      ),
    );

  const states: TurnReceiptState[] = [];
  const journalReadStore = createDrizzleBranchJournalReadStore(db);
  const prepareBranchTurnReversal = createBranchTurnReversalPlanner({
    journalReadStore,
    journal: createDrizzleJournal(db),
  });
  for (const { branch, statuses } of groupBranchCandidates(currentRows).values()) {
    if (statuses.has("active")) {
      const undo = await prepareBranchTurnReversal({
        branch,
        threadId,
        turnId,
        direction: "undo",
      });
      states.push(undo.ok ? "branch-active" : reversalRefusalState(undo.status));
    }
    if (statuses.has("discarded")) {
      const redo = await prepareBranchTurnReversal({
        branch,
        threadId,
        turnId,
        direction: "redo",
      });
      states.push(redo.ok ? "branch-reversed" : "expired");
    }
    if (statuses.has("rollback_pending")) states.push("rollback-pending");
  }
  if (states.length > 0) return states;

  const [historical] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(branchWriteJournal)
    .where(and(eq(branchWriteJournal.threadId, threadId), eq(branchWriteJournal.turnId, turnId)));
  return (historical?.count ?? 0) > 0 ? ["expired"] : [];
}

function reversalRefusalState(
  status: "cant_undo_dependent" | "nothing_to_undo" | "nothing_to_redo",
): TurnReceiptState {
  return status === "cant_undo_dependent" ? "cant_undo_dependent" : "expired";
}

function groupBranchCandidates<
  Row extends {
    journalStatus: BranchJournalRow["status"];
    branchId: string;
  } & Omit<BranchSnapshot, "branchId">,
>(
  rows: readonly Row[],
): Map<string, { branch: BranchSnapshot; statuses: Set<BranchJournalRow["status"]> }> {
  const groups = new Map<
    string,
    { branch: BranchSnapshot; statuses: Set<BranchJournalRow["status"]> }
  >();
  for (const row of rows) {
    const existing = groups.get(row.branchId);
    if (existing) {
      existing.statuses.add(row.journalStatus);
      continue;
    }
    const { journalStatus, ...branch } = row;
    groups.set(row.branchId, {
      branch,
      statuses: new Set([journalStatus]),
    });
  }
  return groups;
}
