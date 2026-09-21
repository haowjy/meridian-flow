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

/**
 * Emit the root's activity after a subagent's drain-woken run settles. Spawn and
 * foreground-message runs are emitted by the child-run driver; a run woken by a
 * child report or `thread_message` is driven by the turn runner and would
 * otherwise leave the last frame frozen at `awake`. Best-effort throughout: a
 * failed lookup or emission never gates the run that just settled.
 */
export async function emitSettledRunActivityBestEffort(input: {
  findThread: (
    threadId: ThreadId,
  ) => Promise<{ id: string; kind: string; rootThreadId: string } | null>;
  threadId: ThreadId;
  eventWriter: EventJournalWriter;
  readActivity: (threadId: ThreadId) => Promise<ThreadActivity>;
  eventSink: EventSink;
}): Promise<void> {
  try {
    const thread = await input.findThread(input.threadId);
    if (thread?.kind !== "subagent") return;
    await appendSubagentActivityBestEffort({
      eventWriter: input.eventWriter,
      readActivity: input.readActivity,
      rootThreadId: thread.rootThreadId as ThreadId,
      childThreadId: thread.id,
      eventSink: input.eventSink,
    });
  } catch (error) {
    emitEvent(input.eventSink, {
      level: "warn",
      source: "runtime.activity",
      name: "subagent.activity.settled_emit_failed",
      correlation: { threadId: input.threadId },
      payload: { threadId: input.threadId, ...unknownToEventPayload(error) },
    });
  }
}
