/** Canonical mutation locks: thread (NO KEY UPDATE), then primary/target Works by id. */
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import { threads, threadWorks } from "@meridian/database/schema";
import { and, eq, inArray } from "drizzle-orm";
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

async function findWorkThreadTree(
  db: DrizzleDb,
  workId: WorkId,
  includeMarked: boolean,
): Promise<{ threadIds: ThreadId[]; liveThreadIds: ThreadId[] }> {
  const activeDb = currentDrizzleDb(db);
  const roots = await activeDb
    .select({ id: threads.id, deletedAt: threads.deletedAt })
    .from(threadWorks)
    .innerJoin(threads, eq(threadWorks.threadId, threads.id))
    .where(and(eq(threadWorks.workId, workId), eq(threadWorks.isPrimary, true)));
  const rows = new Map(roots.map((row) => [row.id, row]));
  if (includeMarked) {
    const marked = await activeDb
      .select({ id: threads.id, deletedAt: threads.deletedAt })
      .from(threads)
      .where(eq(threads.deletedByWorkId, workId));
    for (const row of marked) rows.set(row.id, row);
  }
  let frontier = [...rows.keys()];
  while (frontier.length > 0) {
    const children = await activeDb
      .select({ id: threads.id, deletedAt: threads.deletedAt })
      .from(threads)
      .where(inArray(threads.parentThreadId, frontier));
    frontier = [];
    for (const child of children) {
      if (rows.has(child.id)) continue;
      rows.set(child.id, child);
      frontier.push(child.id);
    }
  }
  const ordered = [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    threadIds: ordered.map(({ id }) => id),
    liveThreadIds: ordered.filter(({ deletedAt }) => !deletedAt).map(({ id }) => id),
  };
}

/**
 * Stabilizes a Work's primary thread forest under the canonical thread-before-Work lock order.
 * `changed` asks the transaction owner to retry instead of letting a newly joined tree escape.
 */
export async function lockWorkThreadTree(
  db: DrizzleDb,
  workId: WorkId,
  options: { includeMarked?: boolean } = {},
): Promise<{
  lifecycle: LockedWorkLifecycle;
  threadIds: ThreadId[];
  liveThreadIds: ThreadId[];
  changed: boolean;
}> {
  const initial = await findWorkThreadTree(db, workId, options.includeMarked ?? false);
  for (const threadId of initial.threadIds) await lockThreadForMutation(db, threadId);
  const lifecycle = await lockWorkLifecycle(db, workId);
  const current = await findWorkThreadTree(db, workId, options.includeMarked ?? false);
  const initialIds = new Set(initial.threadIds);
  return {
    lifecycle,
    ...current,
    changed: current.threadIds.some((threadId) => !initialIds.has(threadId)),
  };
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
