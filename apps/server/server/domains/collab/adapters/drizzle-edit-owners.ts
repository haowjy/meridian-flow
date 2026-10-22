/**
 * Which conversation a write belongs to. A primary thread owns its own writes. A subagent's write rolls
 * up to the nearest primary ancestor (the walk of `parentThreadId`), because the writer knows the parent
 * conversation, not the spawn. The owner's link reveals the spawn row: the outermost child of the owner on
 * the path, in the `thread_execution_reports` row that spawned it.
 */
import { type Database, threadExecutionReports, threads } from "@meridian/database";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { OwnerThread } from "../domain/ports/draft-disposition-store.js";

type Db = Pick<Database, "select">;

export interface EditOwner {
  threadId: string;
  title: string;
  /** The spawn row to reveal when the write is a subagent's; null for a primary thread's own write. */
  spawn: OwnerThread["reveal"] | null;
}

interface ThreadRow {
  id: string;
  title: string;
  kind: string;
  parentThreadId: string | null;
  originTurnId: string | null;
}

/** Owners of the given writing threads, by writing thread id. A thread the walk cannot resolve owns itself. */
export async function resolveEditOwners(
  db: Db,
  writers: readonly string[],
): Promise<Map<string, EditOwner>> {
  const rows = new Map<string, ThreadRow>();
  for (let wanted = [...new Set(writers)]; wanted.length; ) {
    const found = await db
      .select({
        id: threads.id,
        title: threads.title,
        kind: threads.kind,
        parentThreadId: threads.parentThreadId,
        originTurnId: threads.originTurnId,
      })
      .from(threads)
      .where(inArray(threads.id, wanted));
    for (const row of found) rows.set(row.id, row);
    wanted = [
      ...new Set(
        found.flatMap((r) =>
          r.kind !== "primary" && r.parentThreadId && !rows.has(r.parentThreadId)
            ? [r.parentThreadId]
            : [],
        ),
      ),
    ];
  }

  // The path from each writer to its owner: [writer, ..., child of owner, owner].
  const paths = new Map<string, string[]>();
  for (const writer of new Set(writers)) {
    const path = [writer];
    for (let row = rows.get(writer); row && row.kind !== "primary" && row.parentThreadId; ) {
      if (path.includes(row.parentThreadId)) break;
      path.push(row.parentThreadId);
      row = rows.get(row.parentThreadId);
    }
    paths.set(writer, path);
  }
  const children = [...paths.values()].flatMap((p) => (p.length > 1 ? [p[p.length - 2]] : []));
  const spawns = new Map<
    string,
    { callerThreadId: string | null; callerTurnId: string | null; toolCallId: string | null }
  >();
  if (children.length) {
    const reports = await db
      .select({
        childThreadId: threadExecutionReports.childThreadId,
        callerThreadId: threadExecutionReports.callerThreadId,
        callerTurnId: threadExecutionReports.callerTurnId,
        toolCallId: threadExecutionReports.toolCallId,
      })
      .from(threadExecutionReports)
      .where(
        and(
          inArray(threadExecutionReports.childThreadId, children),
          eq(threadExecutionReports.origin, "spawn"),
        ),
      )
      .orderBy(asc(threadExecutionReports.createdAt));
    for (const r of reports) if (!spawns.has(r.childThreadId)) spawns.set(r.childThreadId, r);
  }

  const out = new Map<string, EditOwner>();
  for (const [writer, path] of paths) {
    const ownerId = path[path.length - 1];
    const owner = rows.get(ownerId);
    const child = path.length > 1 ? path[path.length - 2] : null;
    const spawn = child ? spawns.get(child) : undefined;
    const turnId = spawn?.callerTurnId ?? (child ? rows.get(child)?.originTurnId : null);
    out.set(writer, {
      threadId: ownerId,
      title: owner?.title ?? "",
      spawn:
        child && turnId
          ? {
              threadId: ownerId,
              turnId,
              ...(spawn?.toolCallId ? { toolCallId: spawn.toolCallId } : {}),
              subagentThreadId: child,
            }
          : null,
    });
  }
  return out;
}
