/**
 * Authority for the model-callable `continue` tool: one seam that decides
 * whether a caller may drive an existing child conversation once more. 3c
 * allows only the direct parent; a later peer slice widens this function, not
 * its callers.
 */
import { type MeridianError, meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { Thread } from "@meridian/contracts/threads";
import { parseThreadRef, type ThreadRepository } from "../../threads/index.js";

export type ContinueTargetOutcome =
  | { ok: true; target: Thread }
  | { ok: false; error: MeridianError };

function notFound(): ContinueTargetOutcome {
  return {
    ok: false,
    error: meridianErrorFromSystem("continue_target_not_found", "Continue target not found"),
  };
}

export async function authorizeContinueTarget(input: {
  callerThread: Thread;
  targetHandle: string;
  threads: Pick<ThreadRepository, "findLiveByProjectRef">;
}): Promise<ContinueTargetOutcome> {
  // Reject a malformed handle before the DB, so an unknown value stays a
  // uniform not-found rather than a low-level lookup error.
  if (parseThreadRef(input.targetHandle) === null) return notFound();
  const target = await input.threads.findLiveByProjectRef(
    input.callerThread.projectId,
    input.targetHandle,
  );
  if (!target) return notFound();
  // findLiveByProjectRef is already project-scoped, so only ownership remains.
  if (target.userId !== input.callerThread.userId) {
    return notFound();
  }
  if (target.kind !== "subagent" || target.parentThreadId !== input.callerThread.id) {
    return {
      ok: false,
      error: meridianErrorFromSystem(
        "continue_target_not_authorized",
        "Continue target is not a child of this thread",
      ),
    };
  }
  return { ok: true, target };
}
