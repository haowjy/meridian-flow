/**
 * Pure thread-lineage predicates backing `thread_message` authorization.
 * `rootThreadId` is authoritative on every create path (`rootThreadId` = self
 * for a primary, the spawn parent's root for a subagent). A fork starts its own
 * spawn tree, so a fork and its source are not the same lineage; the fork-source
 * edge is covered by the caller's connected scope, not here.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";

/** The thread columns a lineage walk needs; satisfied by a full `Thread` row. */
export type LineageThread = Pick<Thread, "id" | "projectId" | "parentThreadId" | "rootThreadId">;

/** Same project and same spawn root: background authority. */
export function sameLineage(a: LineageThread, b: LineageThread): boolean {
  return a.projectId === b.projectId && a.rootThreadId === b.rootThreadId;
}

/**
 * Foreground authority: `callerThreadId` is `targetThreadId` itself or one of
 * its spawn ancestors (walking `parentThreadId` from the target). Self counts.
 * A missing or cyclic chain is not a match.
 */
export function isInSubtree(
  callerThreadId: ThreadId,
  targetThreadId: ThreadId,
  getThread: (id: ThreadId) => LineageThread | null | undefined,
): boolean {
  const visited = new Set<ThreadId>();
  let currentId: ThreadId | null = targetThreadId;
  while (currentId !== null && !visited.has(currentId)) {
    if (currentId === callerThreadId) return true;
    visited.add(currentId);
    currentId = getThread(currentId)?.parentThreadId ?? null;
  }
  return false;
}
