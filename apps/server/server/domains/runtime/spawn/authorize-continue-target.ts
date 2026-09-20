/**
 * Authority for the model-callable `continue` tool: one seam that decides
 * whether a caller may drive an existing child conversation once more. 3c
 * allows only the direct parent; a later peer slice widens this function, not
 * its callers.
 */
import { type MeridianError, meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import type { ThreadRepository } from "../../threads/index.js";

export interface ContinueTarget {
  kind: "child";
  thread: Thread;
}

export type ContinueTargetOutcome =
  | { ok: true; target: ContinueTarget }
  | { ok: false; error: MeridianError };

function notFound(): ContinueTargetOutcome {
  return {
    ok: false,
    error: meridianErrorFromSystem("continue_target_not_found", "Continue target not found"),
  };
}

export async function authorizeContinueTarget(input: {
  callerThread: Thread;
  targetThreadId: ThreadId;
  threads: Pick<ThreadRepository, "findById">;
}): Promise<ContinueTargetOutcome> {
  const target = await input.threads.findById(input.targetThreadId);
  if (!target) return notFound();
  if (
    target.projectId !== input.callerThread.projectId ||
    target.userId !== input.callerThread.userId
  ) {
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
  return { ok: true, target: { kind: "child", thread: target } };
}
