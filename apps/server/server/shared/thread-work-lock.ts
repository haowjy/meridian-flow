/** Canonical mutation locks: thread (NO KEY UPDATE), then primary/target Works by id. */
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import { threads, threadWorks } from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "./drizzle-transaction.js";
import { type LockedWorkLifecycle, lockWorkLifecycle } from "./work-lifecycle-lock.js";

/** Caller owns the transaction. FK KEY SHARE from Work notices must remain compatible. */
export async function lockThreadForMutation(db: DrizzleDb, threadId: ThreadId) {
  const activeDb = currentDrizzleDb(db);
  const [thread] = await activeDb
    .select({
      id: threads.id,
      projectId: threads.projectId,
      deletedAt: threads.deletedAt,
      activeLeafTurnId: threads.activeLeafTurnId,
    })
    .from(threads)
    .where(eq(threads.id, threadId))
    .for("no key update");
  return thread ?? null;
}

/** Lock every participating Work together, after stabilizing the thread's primary membership. */
export async function lockThreadAndWorks(
  db: DrizzleDb,
  threadId: ThreadId,
  additionalWorkIds: readonly WorkId[] = [],
) {
  const thread = await lockThreadForMutation(db, threadId);
  const activeDb = currentDrizzleDb(db);
  if (!thread) return null;
  // Membership cannot change while the thread row is locked; no snapshot retry is needed.
  const [primary] = await activeDb
    .select({ workId: threadWorks.workId })
    .from(threadWorks)
    .where(and(eq(threadWorks.threadId, threadId), eq(threadWorks.isPrimary, true)));
  const workIds = [...new Set([...additionalWorkIds, ...(primary ? [primary.workId] : [])])].sort();
  const workStates = new Map<WorkId, LockedWorkLifecycle>();
  for (const workId of workIds) workStates.set(workId, await lockWorkLifecycle(db, workId));
  return { ...thread, primaryWorkId: primary?.workId ?? null, workStates };
}
