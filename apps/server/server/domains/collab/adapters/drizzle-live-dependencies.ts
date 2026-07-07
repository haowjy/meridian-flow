/** Drizzle-backed dependency checks for live turn reversal affordances. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  agentEditMutations,
  branchWriteJournal,
  documentYjsUpdates,
} from "@meridian/database/schema";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { hasDependentLaterRows } from "../domain/journal-dependencies.js";

type LiveDependencyDb = Pick<Database, "select">;

type LiveDependencyRow = {
  seq: number;
  updateData: Uint8Array | Buffer;
};

type LaterLiveDependencyRow = LiveDependencyRow & { originType: string | null };

type SelectedMutationRow = LiveDependencyRow & { writeId: string };

export type LiveTurnDependencyStore = {
  checkDependentLaterLiveRows(input: {
    documentId: string;
    threadId: ThreadId;
    turnId: TurnId;
  }): Promise<LiveTurnDependencyCheck>;
  hasDependentLaterLiveRows(input: {
    documentId: string;
    threadId: ThreadId;
    turnId: TurnId;
  }): Promise<boolean>;
};

export type LiveTurnDependencyCheck = {
  hasDependents: boolean;
  /** Highest live journal update seq included in this dependency check. */
  checkedUntilSeq: number;
};

export function createDrizzleLiveTurnDependencyStore(
  db: LiveDependencyDb,
): LiveTurnDependencyStore {
  return {
    checkDependentLaterLiveRows: (input) => checkDependentLaterLiveRows(db, input),
    hasDependentLaterLiveRows: async (input) =>
      (await checkDependentLaterLiveRows(db, input)).hasDependents,
  };
}

export async function hasDependentLaterLiveRows(
  db: LiveDependencyDb,
  input: { documentId: string; threadId: ThreadId; turnId: TurnId },
): Promise<boolean> {
  return (await checkDependentLaterLiveRows(db, input)).hasDependents;
}

export async function checkDependentLaterLiveRows(
  db: LiveDependencyDb,
  input: { documentId: string; threadId: ThreadId; turnId: TurnId },
): Promise<LiveTurnDependencyCheck> {
  const selectedRows = await db
    .select({
      seq: agentEditMutations.createdSeq,
      writeId: agentEditMutations.writeId,
      updateData: documentYjsUpdates.updateData,
    })
    .from(agentEditMutations)
    .innerJoin(
      documentYjsUpdates,
      and(
        eq(documentYjsUpdates.id, agentEditMutations.createdSeq),
        eq(documentYjsUpdates.documentId, agentEditMutations.documentId),
      ),
    )
    .where(
      and(
        eq(agentEditMutations.documentId, input.documentId as never),
        eq(agentEditMutations.threadId, input.threadId),
        eq(agentEditMutations.turnId, input.turnId),
        eq(agentEditMutations.status, "active"),
      ),
    )
    .orderBy(asc(agentEditMutations.createdSeq));

  if (selectedRows.length === 0) {
    return {
      hasDependents: false,
      checkedUntilSeq: await latestLiveUpdateSeq(db, input.documentId),
    };
  }

  const selected = await selectedDependencyRows(db, selectedRows);
  const maxSelectedSeq = Math.max(...selectedRows.map((row) => Number(row.seq)));
  const laterRows = await db
    .select({
      seq: documentYjsUpdates.id,
      updateData: documentYjsUpdates.updateData,
      originType: documentYjsUpdates.originType,
    })
    .from(documentYjsUpdates)
    .where(
      and(
        eq(documentYjsUpdates.documentId, input.documentId as never),
        gt(documentYjsUpdates.id, maxSelectedSeq),
      ),
    )
    .orderBy(asc(documentYjsUpdates.id));

  const checkedUntilSeq = Math.max(maxSelectedSeq, ...laterRows.map((row) => Number(row.seq)));
  return {
    hasDependents:
      selected.length > 0 &&
      hasDependentLaterRows(selected, laterRows.filter(isNonSystemLiveDependencyRow)),
    checkedUntilSeq,
  };
}

async function selectedDependencyRows(
  db: LiveDependencyDb,
  selectedRows: readonly SelectedMutationRow[],
): Promise<LiveDependencyRow[]> {
  const pushedBranchRowIds = selectedRows.flatMap((row) => pushedBranchJournalId(row.writeId));
  if (pushedBranchRowIds.length === 0) return dedupeBySeq(selectedRows);

  const branchRows = await db
    .select({ seq: branchWriteJournal.id, updateData: branchWriteJournal.updateData })
    .from(branchWriteJournal)
    .where(inArray(branchWriteJournal.id, pushedBranchRowIds));
  const branchById = new Map(branchRows.map((row) => [Number(row.seq), row.updateData]));
  return selectedRows.map((row) => {
    const branchRowId = pushedBranchJournalId(row.writeId)[0];
    const updateData = branchRowId === undefined ? undefined : branchById.get(branchRowId);
    return updateData ? { seq: row.seq, updateData } : row;
  });
}

function pushedBranchJournalId(writeId: string): number[] {
  const match = /^push:[^:]+:(\d+)$/.exec(writeId);
  if (!match) return [];
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? [id] : [];
}

function dedupeBySeq(rows: readonly LiveDependencyRow[]): LiveDependencyRow[] {
  const bySeq = new Map<number, LiveDependencyRow>();
  for (const row of rows) bySeq.set(Number(row.seq), row);
  return [...bySeq.values()].sort((left, right) => Number(left.seq) - Number(right.seq));
}

function isNonSystemLiveDependencyRow(row: LaterLiveDependencyRow): boolean {
  return row.originType !== "system";
}

async function latestLiveUpdateSeq(db: LiveDependencyDb, documentId: string): Promise<number> {
  const [row] = await db
    .select({ seq: documentYjsUpdates.id })
    .from(documentYjsUpdates)
    .where(eq(documentYjsUpdates.documentId, documentId as never))
    .orderBy(desc(documentYjsUpdates.id))
    .limit(1);
  return row?.seq ? Number(row.seq) : 0;
}
