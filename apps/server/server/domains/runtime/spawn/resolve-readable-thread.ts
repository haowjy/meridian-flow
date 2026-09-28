/** One owner/project/lineage authority for model-facing conversation reads. */
import { type MeridianError, meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import { parseThreadRef, type Thread } from "@meridian/contracts/threads";
import { sameLineage } from "../../threads/domain/lineage.js";
import type { ThreadRepository } from "../../threads/index.js";

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
}): Promise<ReadableThreadOutcome> {
  const ref = input.ref ?? input.caller.ref;
  if (!ref || !parseThreadRef(ref)) return threadReadError("thread_not_found", "Thread not found");
  const target = await input.threads.findLiveByProjectRef(input.caller.projectId, ref);
  if (
    !target ||
    target.userId !== input.caller.userId ||
    target.projectId !== input.caller.projectId
  )
    return threadReadError("thread_not_found", "Thread not found");
  if (!sameLineage(input.caller, target))
    return threadReadError("thread_not_connected", "Thread is not in your connected lineage");
  return { ok: true, target };
}
