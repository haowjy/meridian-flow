/**
 * The one producer of the `subagent.activity` journal fact: reads the run-tree
 * root's recomputed activity and appends it to the root thread's journal. Both
 * child-run producers (create and terminal) call this so the event shape and the
 * read-then-append ordering have a single owner.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { ThreadActivity } from "@meridian/contracts/threads";
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
