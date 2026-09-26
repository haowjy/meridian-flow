/**
 * Pure thread-lineage predicates backing `thread_message` authorization.
 * `rootThreadId` is authoritative on every create path: self for an organic
 * root, the spawn parent's root for a subagent, and the SOURCE's root for a
 * fork/handoff derivation. A fork/handoff is a sibling of its source, not the
 * source's child: it takes the source's `parentThreadId` too (null when the
 * source is itself a root), so `sameLineage` holds between a fork and its
 * source but `isInSubtree` does not — siblings share background authority,
 * never foreground authority over each other's subtree. The fork-source edge
 * itself is not a lineage fact; it is covered by `originTurnId` (the source's
 * anchor turn), not by this module.
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
