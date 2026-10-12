/** Transactional trail invalidation. Resolve semantic ownership before taking any Work/document lock. */

import type { WorkId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleDb,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import {
  lockDraftBranchWorks,
  runWithActiveWorkDrafts,
} from "../../../shared/work-draft-lifecycle.js";

import { BranchCasConflictError } from "../domain/branch-coordinator.js";

const values = (ids: readonly (string | number)[]) =>
  sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]`;

export interface AffectedTrailOwners {
  owners?: readonly { threadId?: string | null; turnId?: string | null }[];
  turnIds?: readonly string[];
  editIds?: readonly string[];
  journalIds?: readonly number[];
  branchIds?: readonly string[];
  pushIds?: readonly (string | number)[];
}

async function resolveTrailOwners(db: DrizzleDb, affected: AffectedTrailOwners) {
  return db.execute<{ thread_id: string; turn_id: string | null }>(sql`
    WITH RECURSIVE pushes AS (
      SELECT * FROM push_lineage WHERE id = ANY(${values(affected.pushIds?.map(String) ?? [])}::bigint[])
    ), journals AS (
      SELECT journal.* FROM branch_write_journal journal
      WHERE journal.id = ANY(${values(affected.journalIds ?? [])}::bigint[])
        OR journal.branch_id = ANY(${values(affected.branchIds ?? [])}::text[])
        OR EXISTS (SELECT 1 FROM pushes WHERE journal.id = ANY(pushes.journal_ids))
    ), edits(id) AS (
      SELECT id FROM document_edits WHERE id = ANY(${values(affected.editIds ?? [])}::uuid[])
      UNION
      SELECT edit_id FROM document_edit_parts part WHERE
        part.placement->>'branchId' = ANY(${values(affected.branchIds ?? [])}::text[])
        OR EXISTS (SELECT 1 FROM journals WHERE journals.update_meta->'documentEdit'->>'editId' = part.edit_id::text)
      UNION
      SELECT (target->>'editId')::uuid FROM edits
      JOIN document_edit_parts part ON part.edit_id = edits.id
      CROSS JOIN LATERAL jsonb_array_elements(part.targets) target
    ), owners AS (
      SELECT thread_id, turn_id FROM jsonb_to_recordset(${JSON.stringify((affected.owners ?? []).filter((owner) => owner.threadId).map((owner) => ({ thread_id: owner.threadId, turn_id: owner.turnId ?? null })))}::jsonb)
        AS direct(thread_id uuid, turn_id uuid)
      UNION SELECT thread_id, id FROM turns WHERE id = ANY(${values(affected.turnIds ?? [])}::uuid[])
      UNION SELECT thread_id, turn_id FROM journals
      UNION SELECT thread_id, turn_id FROM pushes
      UNION SELECT thread_id, turn_id FROM document_edits WHERE id IN (SELECT id FROM edits)
    ) SELECT DISTINCT thread_id, turn_id FROM owners WHERE thread_id IS NOT NULL
  `);
}

/**
 * Call at the command boundary, in the write transaction, before Work, advisory,
 * journal or outbox locks. Immutable targets carry ownership, not the inverse's
 * actor. All threads lock before ANY turn, including multi-chat publications.
 */
export async function invalidateTrailOwners(tx: DrizzleDb, affected: AffectedTrailOwners) {
  const db = currentDrizzleDb(tx);
  if (!("rollback" in db)) throw new Error("Trail invalidation requires a write transaction");
  const rows = await resolveTrailOwners(db, affected);
  const threadIds = [...new Set(rows.map((row) => row.thread_id))].sort();
  if (!threadIds.length) return rows;
  const turnIds = [...new Set(rows.flatMap((row) => (row.turn_id ? [row.turn_id] : [])))].sort();
  await db.execute(
    sql`SELECT id FROM threads WHERE id = ANY(${values(threadIds)}::uuid[]) ORDER BY id FOR NO KEY UPDATE`,
  );
  if (turnIds.length)
    await db.execute(
      sql`SELECT id FROM turns WHERE id = ANY(${values(turnIds)}::uuid[]) ORDER BY id FOR NO KEY UPDATE`,
    );
  await db.execute(
    sql`UPDATE threads SET trail_dirty_revision = trail_dirty_revision + 1 WHERE id = ANY(${values(threadIds)}::uuid[])`,
  );
  if (turnIds.length)
    await db.execute(
      sql`UPDATE turns SET trail_dirty_revision = trail_dirty_revision + 1 WHERE id = ANY(${values(turnIds)}::uuid[])`,
    );
  return rows;
}

/** Draft commands resolve their complete journal/receipt owner set ahead of the Work seam. */
export async function runWithTrailDrafts<T>(
  db: Database,
  input: {
    workIds?: readonly WorkId[];
    branchIds?: readonly string[];
    owners?: AffectedTrailOwners["owners"];
  },
  operation: () => Promise<T>,
): Promise<T> {
  return runInDrizzleTransaction(db, async () => {
    const affected =
      input.owners !== undefined ? { owners: input.owners } : { branchIds: input.branchIds };
    const locked = await invalidateTrailOwners(currentDrizzleDb(db), affected);
    return runWithActiveWorkDrafts(db, input, async () => {
      await assertOwnerCut(currentDrizzleDb(db), affected, locked);
      return operation();
    });
  });
}

/** Discovery precedes Work locking; refuse a changed owner cut instead of acquiring late owner locks. */
async function assertOwnerCut(
  db: DrizzleDb,
  affected: AffectedTrailOwners,
  locked: readonly { thread_id: string; turn_id: string | null }[],
) {
  const keys = new Set(locked.map((row) => `${row.thread_id}/${row.turn_id ?? ""}`));
  const current = await resolveTrailOwners(db, affected);
  if (current.some((row) => !keys.has(`${row.thread_id}/${row.turn_id ?? ""}`))) {
    throw new BranchCasConflictError(affected.branchIds?.[0] ?? "trail-owner-cut");
  }
}

export async function lockTrailDraftWorks(db: Database, branchIds: readonly string[]) {
  return runInDrizzleTransaction(db, async () => {
    const affected = { branchIds };
    const locked = await invalidateTrailOwners(currentDrizzleDb(db), affected);
    const frozen = await lockDraftBranchWorks(db, branchIds);
    await assertOwnerCut(currentDrizzleDb(db), affected, locked);
    return frozen;
  });
}
