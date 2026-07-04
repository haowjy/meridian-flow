/**
 * Thread list projection helpers: derive UI-facing lifecycle fields from the
 * canonical thread row plus latest-turn/work joins. Shared by repository adapters.
 */
import type { Thread, ThreadListItem, TurnRole, TurnStatus } from "@meridian/contracts/threads";

export interface ThreadListSummary {
  running: number;
  waiting: number;
  idle: number;
  totalThreads: number;
}

export interface ThreadListProjectionInput {
  thread: Thread;
  workTitle: string | null;
  lastTurnRole: TurnRole | null;
  lastTurnStatus: TurnStatus | null;
  runningTurnId: string | null;
  pendingDraftCount: number;
}

export function isWaitingForUser(
  threadStatus: Thread["status"],
  lastTurnRole: TurnRole | null,
  lastTurnStatus: TurnStatus | null,
): boolean {
  return threadStatus === "idle" && lastTurnRole === "assistant" && lastTurnStatus === "complete";
}

export function toThreadListItem(input: ThreadListProjectionInput): ThreadListItem {
  return {
    ...input.thread,
    work:
      input.thread.workId && input.workTitle
        ? { id: input.thread.workId, title: input.workTitle }
        : null,
    waitingForUser: isWaitingForUser(input.thread.status, input.lastTurnRole, input.lastTurnStatus),
    runningTurnId: input.runningTurnId,
    pendingDraftCount: input.pendingDraftCount,
  };
}

export function summarizeThreadList(threads: ThreadListItem[]): ThreadListSummary {
  let running = 0;
  let waiting = 0;
  let idle = 0;

  for (const thread of threads) {
    if (thread.runningTurnId) {
      running += 1;
    } else if (thread.waitingForUser) {
      waiting += 1;
    } else if (thread.status === "idle") {
      idle += 1;
    }
  }

  return {
    running,
    waiting,
    idle,
    totalThreads: threads.length,
  };
}
