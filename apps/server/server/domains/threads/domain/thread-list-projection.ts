/**
 * Thread list projection helpers: derive UI-facing lifecycle fields from the
 * canonical thread row plus logical-head/work joins. Shared by repository adapters.
 */
import type { Thread, ThreadListItem } from "@meridian/contracts/threads";

export interface ThreadListProjectionInput {
  thread: Thread;
  workTitle: string | null;
  actionRequired: boolean;
  runningTurnId: string | null;
}

export function toThreadListItem(input: ThreadListProjectionInput): ThreadListItem {
  return {
    ...input.thread,
    work:
      input.thread.workId && input.workTitle
        ? { id: input.thread.workId, title: input.workTitle }
        : null,
    actionRequired: input.actionRequired,
    runningTurnId: input.runningTurnId,
  };
}
