import { type MeridianError, meridianErrorFromSystem } from "@meridian/contracts/errors";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import { parseThreadRef } from "@meridian/contracts/threads";
import { isInSubtree } from "../../threads/domain/lineage.js";
import type { ThreadRepository } from "../../threads/index.js";
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
  if (parseThreadRef(input.targetRef) === null) return notFound();
  const target = await input.threads.findLiveByProjectRef(
    input.callerThread.projectId,
    input.targetRef,
  );
  if (!target) return notFound();
  if (target.userId !== input.callerThread.userId) return notFound();

  if (input.mode === "background") return { ok: true, target };

  if (!(await isInCallerSubtree(input.callerThread.id, target, input.threads))) {
    return notAuthorized("Foreground messages are limited to the caller's subtree");
  }
  return { ok: true, target };
}

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
