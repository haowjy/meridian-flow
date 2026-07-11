/** Claims and retries durable turn trail work. */
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInRootDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";

const MAX_WORK_ATTEMPTS = 5;

/** Claims one durable unit. A crash leaves `running`, which the next poll reclaims. */
export async function retryTurnTrailWork(
  db: Database,
  retryBranch: ((branchId: string) => Promise<unknown>) | undefined,
  onRetryExhausted: ((threadId: string, documentId: string) => void) | undefined,
): Promise<void> {
  const claimed = await runInRootDrizzleTransaction(db, async () => {
    const tx = currentDrizzleDb(db);
    const rows = await tx.execute(sql`
      SELECT work.journal_id, work.branch_id, work.thread_id, work.attempts,
        branch.push_policy, branch.document_id, turn.status
      FROM turn_trail_work work
      JOIN document_branches branch ON branch.id = work.branch_id
      JOIN turns turn ON turn.id = work.turn_id
      WHERE (work.state = 'pending' AND work.next_attempt_at <= now())
         OR (work.state = 'running' AND work.updated_at < now() - interval '30 seconds')
      ORDER BY work.next_attempt_at, work.journal_id
      FOR UPDATE OF work SKIP LOCKED LIMIT 1
    `);
    const row = rows[0] as
      | {
          journal_id: number;
          branch_id: string;
          thread_id: string;
          document_id: string;
          attempts: number;
          push_policy: string;
          status: string;
        }
      | undefined;
    if (!row) return null;
    if (row.push_policy !== "auto" || ["cancelled", "error"].includes(row.status)) {
      await tx.execute(
        sql`UPDATE turn_trail_work SET state = 'no_op', updated_at = now() WHERE journal_id = ${row.journal_id}`,
      );
      return null;
    }
    await tx.execute(
      sql`UPDATE turn_trail_work SET state = 'running', attempts = attempts + 1, updated_at = now() WHERE journal_id = ${row.journal_id}`,
    );
    return row;
  });
  if (!claimed || !retryBranch) return;
  try {
    await retryBranch(claimed.branch_id);
  } catch (cause) {
    const attempts = claimed.attempts + 1;
    const exhausted = attempts >= MAX_WORK_ATTEMPTS;
    const delaySeconds = Math.min(2 ** attempts, 30);
    await db.execute(sql`
      UPDATE turn_trail_work SET
        state = ${exhausted ? "exhausted" : "pending"},
        next_attempt_at = now() + (${delaySeconds} * interval '1 second'),
        last_error = ${cause instanceof Error ? cause.message : String(cause)}, updated_at = now()
      WHERE journal_id = ${claimed.journal_id} AND state = 'running'
    `);
    if (exhausted) onRetryExhausted?.(claimed.thread_id, claimed.document_id);
    return;
  }
  await db.execute(sql`
    UPDATE turn_trail_work work SET
      state = CASE WHEN journal.status IN ('pushed', 'discarded') THEN 'complete' ELSE 'pending' END,
      next_attempt_at = now() + interval '1 second', updated_at = now()
    FROM branch_write_journal journal
    WHERE work.journal_id = ${claimed.journal_id} AND journal.id = work.journal_id
  `);
}
