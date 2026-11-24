import type { ThreadId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";

export type LineageThread = Pick<Thread, "id" | "projectId" | "parentThreadId" | "rootThreadId">;

export function sameLineage(a: LineageThread, b: LineageThread): boolean {
  return a.projectId === b.projectId && a.rootThreadId === b.rootThreadId;
}

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
