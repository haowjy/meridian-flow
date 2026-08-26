/** Thread trash restoration plus its transactional Work-context refresh obligation. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import type { ThreadRepositories } from "../ports/repositories.js";

export async function restoreThreadFromTrash(
  deps: {
    repos: Pick<ThreadRepositories, "threads" | "transaction">;
    workContextDelivery: { threadChanged(threadId: ThreadId): Promise<void> };
  },
  threadId: ThreadId,
): Promise<Thread> {
  return deps.repos.transaction(async () => {
    const thread = await deps.repos.threads.restore(threadId);
    // An obligation has no payload, so coalescing here covers both a parked
    // request and Work changes that occurred only while the chat was hidden.
    await deps.workContextDelivery.threadChanged(threadId);
    return thread;
  });
}
