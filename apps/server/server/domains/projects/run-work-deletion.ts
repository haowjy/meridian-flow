/** Shared retry and post-commit runtime cleanup for commands that delete Works. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { WorkDeleteRetryError } from "./ports/work-repository.js";

type WorkDeletionResult<T> = { value: T; threadIdsToStop: readonly ThreadId[] };

export async function runWorkDeletion<T>(
  deps: {
    transaction<R>(operation: () => Promise<R>): Promise<R>;
    stopThreadRun(threadId: ThreadId): Promise<void>;
  },
  operation: () => Promise<WorkDeletionResult<T>>,
): Promise<T> {
  let committed: WorkDeletionResult<T> | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      committed = await deps.transaction(operation);
      break;
    } catch (cause) {
      if (!(cause instanceof WorkDeleteRetryError) || attempt === 4) throw cause;
    }
  }
  if (!committed) throw new Error("Work deletion did not complete");
  await Promise.all(committed.threadIdsToStop.map(deps.stopThreadRun));
  return committed.value;
}
