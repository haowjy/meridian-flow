/** Drizzle-backed dependency checks for live turn reversal affordances. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  agentEditMutations,
  branchWriteJournal,
  documentYjsUpdates,
} from "@meridian/database/schema";
import { and, asc, eq, gt, inArray, ne } from "drizzle-orm";
import {
  type ClockRange,
  type DecodedUpdateLike,
  decodeUpdateForDependencies,
  deleteRanges,
  rangesOverlap,
  suppliedRanges,
} from "../domain/journal-dependencies.js";

type LiveDependencyDb = Pick<Database, "select">;

type LiveDependencyRow = {
  seq: number;
  updateData: Uint8Array | Buffer;
};

type SelectedMutationRow = LiveDependencyRow & { writeId: string };

export type LiveTurnDependencyStore = {
  hasDependentLaterLiveRows(input: {
    documentId: string;
    threadId: ThreadId;
    turnId: TurnId;
  }): Promise<boolean>;
};

export function createDrizzleLiveTurnDependencyStore(
  db: LiveDependencyDb,
): LiveTurnDependencyStore {
  return {
    hasDependentLaterLiveRows: (input) => hasDependentLaterLiveRows(db, input),
  };
}

export async function hasDependentLaterLiveRows(
  db: LiveDependencyDb,
  input: { documentId: string; threadId: ThreadId; turnId: TurnId },
): Promise<boolean> {
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
  const selected = await selectedDependencyRows(db, selectedRows);
  if (selected.length === 0) return false;

  const maxSelectedSeq = Math.max(...selectedRows.map((row) => Number(row.seq)));
  const laterRows = await db
    .select({ seq: documentYjsUpdates.id, updateData: documentYjsUpdates.updateData })
    .from(documentYjsUpdates)
    .where(
      and(
        eq(documentYjsUpdates.documentId, input.documentId as never),
        gt(documentYjsUpdates.id, maxSelectedSeq),
        ne(documentYjsUpdates.originType, "system"),
      ),
    )
    .orderBy(asc(documentYjsUpdates.id));

  return hasLiveUndoDependentLaterRows(selected, laterRows);
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

function hasLiveUndoDependentLaterRows(
  selectedRows: readonly LiveDependencyRow[],
  laterRows: readonly LiveDependencyRow[],
): boolean {
  const selectedSupplied: ClockRange[] = [];
  const selectedDeleted: ClockRange[] = [];
  for (const row of selectedRows) {
    const decoded = decodeUpdateForDependencies(row.updateData);
    selectedSupplied.push(...suppliedRanges(decoded));
    selectedDeleted.push(...deleteRanges(decoded));
  }
  if (selectedSupplied.length === 0 && selectedDeleted.length === 0) return false;

  return laterRows.some((row) => {
    const decoded = decodeUpdateForDependencies(row.updateData);
    return (
      liveContentDependencies(decoded).some((dependency) =>
        selectedSupplied.some((range) => rangesOverlap(range, dependency)),
      ) ||
      deleteRanges(decoded).some((deleted) =>
        [...selectedSupplied, ...selectedDeleted].some((range) => rangesOverlap(range, deleted)),
      )
    );
  });
}

function liveContentDependencies(decoded: DecodedUpdateLike): ClockRange[] {
  const refs: ClockRange[] = [];
  for (const struct of decoded.structs ?? []) {
    if (struct.origin) refs.push({ ...struct.origin, length: 1 });
    if (isYId(struct.parent)) refs.push({ ...struct.parent, length: 1 });
  }
  return refs;
}

function isYId(value: unknown): value is { client: number; clock: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { client: number }).client === "number" &&
    typeof (value as { clock: number }).clock === "number"
  );
}
