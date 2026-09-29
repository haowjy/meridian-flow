/** Shared retry and post-commit runtime cleanup for Work lifecycle commands with retryable locking. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { WorkDeleteRetryError } from "./ports/work-repository.js";

type WorkLifecycleCommandResult<T> = { value: T; threadIdsToStop: readonly ThreadId[] };

export async function runWorkLifecycleCommand<T>(
  deps: {
    transaction<R>(operation: () => Promise<R>): Promise<R>;
    stopThreadRun(threadId: ThreadId): Promise<void>;
  },
  operation: () => Promise<WorkLifecycleCommandResult<T>>,
): Promise<T> {
  let committed: WorkLifecycleCommandResult<T> | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      committed = await deps.transaction(operation);
      break;
    } catch (cause) {
      if (!(cause instanceof WorkDeleteRetryError) || attempt === 4) throw cause;
    }
  }
  if (!committed) throw new Error("Work lifecycle command did not complete");
  await Promise.all(committed.threadIdsToStop.map(deps.stopThreadRun));
  return committed.value;
}
