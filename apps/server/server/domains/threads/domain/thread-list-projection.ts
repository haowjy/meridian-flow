/**
 * Thread list projection helpers: derive UI-facing lifecycle fields from the
 * canonical thread row plus logical-head/work joins. Shared by repository adapters.
 */
import type { Thread, ThreadListItem, TurnRole, TurnStatus } from "@meridian/contracts/threads";
import { isThreadActionRequired } from "./visible-conversation-policy.js";

export interface ThreadListProjectionInput {
  thread: Thread;
  workTitle: string | null;
  lastTurnRole: TurnRole | null;
  lastTurnStatus: TurnStatus | null;
  runningTurnId: string | null;
}

export function projectThreadActionRequired(
  lastTurnRole: TurnRole | null,
  lastTurnStatus: TurnStatus | null,
): boolean {
  return isThreadActionRequired({
    headRole: lastTurnRole,
    headStatus: lastTurnStatus,
  });
}

export function toThreadListItem(input: ThreadListProjectionInput): ThreadListItem {
  return {
    ...input.thread,
    work:
      input.thread.workId && input.workTitle
        ? { id: input.thread.workId, title: input.workTitle }
        : null,
    actionRequired: projectThreadActionRequired(input.lastTurnRole, input.lastTurnStatus),
    runningTurnId: input.runningTurnId,
  };
}
