/**
 * The one producer of the `subagent.activity` journal fact: reads the run-tree
 * root's recomputed activity and appends it to the root thread's journal. Both
 * child-run producers (create and terminal) call this so the event shape and the
 * read-then-append ordering have a single owner. The best-effort variant owns
 * the rule that a failed emission never gates a run.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { ThreadActivity } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { EventJournalWriter } from "../../threads/index.js";

export async function appendSubagentActivity(input: {
  eventWriter: EventJournalWriter;
  readActivity: (threadId: ThreadId) => Promise<ThreadActivity>;
  rootThreadId: ThreadId;
  childThreadId: string;
}): Promise<bigint> {
  const activity = await input.readActivity(input.rootThreadId);
  return input.eventWriter.appendEvent(input.rootThreadId, {
    type: "subagent.activity",
    rootThreadId: input.rootThreadId,
    childThreadId: input.childThreadId,
    activity,
  });
}

/**
 * The read-model event is a side effect, not part of the run result: a failed
 * read or append is reported to the `EventSink` and swallowed so it can never
 * fail a run or write a second, contradictory terminal fact.
 */
export async function appendSubagentActivityBestEffort(input: {
  eventWriter: EventJournalWriter;
  readActivity: (threadId: ThreadId) => Promise<ThreadActivity>;
  rootThreadId: ThreadId;
  childThreadId: string;
  eventSink: EventSink;
}): Promise<void> {
  try {
    await appendSubagentActivity(input);
  } catch (error) {
    emitEvent(input.eventSink, {
      level: "warn",
      source: "runtime.activity",
      name: "subagent.activity.append_failed",
      correlation: { threadId: input.rootThreadId, childRunId: input.childThreadId },
      payload: {
        childThreadId: input.childThreadId,
        ...unknownToEventPayload(error),
      },
    });
  }
}
