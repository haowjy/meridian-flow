/**
 * The wake recovery path. The wake need is derived, never stored: a pending
 * undelivered message on a thread with no live lease. For each such thread the
 * sweep starts a drain-only run; when a live holder already exists the `enqueue`
 * wake owns it, so the sweep skips it.
 *
 * A sweep is not a polling turn: it starts a run only when a durable pending
 * message already exists, and never generates a turn to ask whether work is done.
 */
import type { Inbox, RunAuthority, RunStarter } from "./ports.js";

export async function sweepWakes(input: {
  inbox: Pick<Inbox, "pendingMessageThreads">;
  authority: Pick<RunAuthority, "holder">;
  runStarter: RunStarter;
  limit: number;
}): Promise<void> {
  const threadIds = await input.inbox.pendingMessageThreads(input.limit);
  for (const threadId of threadIds) {
    if ((await input.authority.holder(threadId)) !== null) continue;
    try {
      await input.runStarter.start(threadId);
    } catch {
      // Best-effort recovery: one thread's failure must not strand the rest.
    }
  }
}
