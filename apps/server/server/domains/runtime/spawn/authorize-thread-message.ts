/**
 * Authority for the model-callable `thread_message` tool. Background delivery is
 * authorized by lineage (same project and `rootThreadId`); foreground by subtree
 * (the target is the caller or a descendant, walking `parentThreadId`), which
 * prevents a wait cycle on an ancestor. Resolves the model-facing `ref` inside
 * the caller's project; the internal id never crosses the tool boundary.
 */
import { type MeridianError, meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import { isInSubtree, sameLineage } from "../../threads/domain/lineage.js";
import { parseThreadRef, type ThreadRepository } from "../../threads/index.js";
import type { ThreadMessageMode } from "../tools/spawn-tools.js";

export type ThreadMessageTargetOutcome =
  | { ok: true; target: Thread }
  | { ok: false; error: MeridianError };

function notFound(): ThreadMessageTargetOutcome {
  return {
    ok: false,
    error: meridianErrorFromSystem("thread_message_target_not_found", "Thread not found"),
  };
}

function notAuthorized(message: string): ThreadMessageTargetOutcome {
  return {
    ok: false,
    error: meridianErrorFromSystem("thread_message_not_authorized", message),
  };
}

export async function authorizeThreadMessage(input: {
  callerThread: Thread;
  targetRef: string;
  mode: ThreadMessageMode;
  threads: Pick<ThreadRepository, "findLiveByProjectRef" | "findById">;
}): Promise<ThreadMessageTargetOutcome> {
  // Reject a malformed ref before the DB, so an unknown value stays a uniform
  // not-found rather than a low-level lookup error.
  if (parseThreadRef(input.targetRef) === null) return notFound();
  const target = await input.threads.findLiveByProjectRef(
    input.callerThread.projectId,
    input.targetRef,
  );
  if (!target) return notFound();
  if (target.userId !== input.callerThread.userId) return notFound();

  if (input.mode === "background") {
    if (!sameLineage(input.callerThread, target)) {
      return notAuthorized("Background messages are limited to the caller's lineage");
    }
    return { ok: true, target };
  }

  if (!(await isInCallerSubtree(input.callerThread.id, target, input.threads))) {
    return notAuthorized("Foreground messages are limited to the caller's subtree");
  }
  return { ok: true, target };
}

/**
 * Synchronously walks `parentThreadId` from the target, but the thread rows are
 * async to fetch. Populate the whole ancestor chain into a local cache first,
 * then run the shared `isInSubtree` predicate over it.
 */
async function isInCallerSubtree(
  callerThreadId: ThreadId,
  target: Thread,
  threads: Pick<ThreadRepository, "findById">,
): Promise<boolean> {
  const cache = new Map<ThreadId, Thread>();
  cache.set(target.id as ThreadId, target);
  let currentId = target.parentThreadId as ThreadId | null;
  while (currentId !== null && !cache.has(currentId)) {
    const ancestor = await threads.findById(currentId);
    if (!ancestor) break;
    cache.set(currentId, ancestor);
    currentId = ancestor.parentThreadId as ThreadId | null;
  }
  return isInSubtree(callerThreadId, target.id as ThreadId, (id) => cache.get(id) ?? null);
}
