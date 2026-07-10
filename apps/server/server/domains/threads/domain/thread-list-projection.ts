/**
 * Thread list projection helpers: derive UI-facing lifecycle fields from the
 * canonical thread row plus logical-head/work joins. Shared by repository adapters.
 */
import type {
  Thread,
  ThreadAttention,
  ThreadListItem,
  TurnRole,
  TurnStatus,
} from "@meridian/contracts/threads";

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
  lastTurnAt: string | null;
  lastOpenedAt: string | null;
  runningTurnId: string | null;
}

export function projectThreadAttention(
  threadStatus: Thread["status"],
  lastTurnRole: TurnRole | null,
  lastTurnStatus: TurnStatus | null,
  lastTurnAt: string | null,
  lastOpenedAt: string | null,
): ThreadAttention {
  if (lastTurnRole === "assistant" && lastTurnStatus === "waiting_interrupt") {
    return "actionRequired";
  }
  if (
    threadStatus === "idle" &&
    lastTurnRole === "assistant" &&
    lastTurnStatus === "complete" &&
    lastTurnAt !== null &&
    (lastOpenedAt === null || new Date(lastOpenedAt) < new Date(lastTurnAt))
  ) {
    return "unread";
  }
  return "none";
}

export function toThreadListItem(input: ThreadListProjectionInput): ThreadListItem {
  return {
    ...input.thread,
    work:
      input.thread.workId && input.workTitle
        ? { id: input.thread.workId, title: input.workTitle }
        : null,
    attention: projectThreadAttention(
      input.thread.status,
      input.lastTurnRole,
      input.lastTurnStatus,
      input.lastTurnAt,
      input.lastOpenedAt,
    ),
    runningTurnId: input.runningTurnId,
  };
}

export function summarizeThreadList(threads: ThreadListItem[]): ThreadListSummary {
  let running = 0;
  let waiting = 0;
  let idle = 0;

  for (const thread of threads) {
    if (thread.runningTurnId) {
      running += 1;
    } else if (thread.attention !== "none") {
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
