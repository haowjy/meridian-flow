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
import { projectEffectiveThreadAttention } from "./visible-conversation-policy.js";

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
  return projectEffectiveThreadAttention({
    threadStatus,
    headRole: lastTurnRole,
    headStatus: lastTurnStatus,
    headActivityAt: lastTurnAt,
    lastOpenedAt,
  });
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
