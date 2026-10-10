/** Shared connection authority for conversation reads and background messages. */
import { type MeridianError, meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import { parseThreadRef, type Thread } from "@meridian/contracts/threads";
import { sameLineage } from "../../threads/domain/lineage.js";
import type { ThreadRepository, TurnRepository } from "../../threads/index.js";

export type ReadableThreadOutcome =
  | { ok: true; target: Thread }
  | { ok: false; error: MeridianError };
export function threadReadError(
  code: string,
  message: string,
): { ok: false; error: MeridianError } {
  return { ok: false, error: meridianErrorFromSystem(code, message) };
}
export async function resolveReadableThread(input: {
  caller: Thread;
  ref?: string;
  threads: Pick<ThreadRepository, "findLiveByProjectRef">;
  turns: Pick<TurnRepository, "findById">;
}): Promise<ReadableThreadOutcome> {
  const ref = input.ref === undefined || input.ref === "current" ? input.caller.ref : input.ref;
  if (!ref || !parseThreadRef(ref)) return threadReadError("thread_not_found", "Thread not found");
  const target = await input.threads.findLiveByProjectRef(input.caller.projectId, ref);
  if (
    !target ||
    target.userId !== input.caller.userId ||
    target.projectId !== input.caller.projectId
  )
    return threadReadError("thread_not_found", "Thread not found");
  if (!(await areThreadsConnected(input.caller, target, input.turns)))
    return threadReadError("thread_not_connected", "Thread is not connected to this conversation");
  return { ok: true, target };
}

/** Handoff provenance connects only its direct cutoff owner, not either lineage. */
export async function areThreadsConnected(
  caller: Thread,
  target: Thread,
  turns: Pick<TurnRepository, "findById">,
): Promise<boolean> {
  if (caller.projectId !== target.projectId || caller.userId !== target.userId) return false;
  if (sameLineage(caller, target)) return true;
  if (caller.originType === "handoff" && caller.originTurnId) {
    const origin = await turns.findById(caller.originTurnId);
    if (origin?.threadId === target.id) return true;
  }
  if (target.originType === "handoff" && target.originTurnId) {
    const origin = await turns.findById(target.originTurnId);
    if (origin?.threadId === caller.id) return true;
  }
  return false;
}
