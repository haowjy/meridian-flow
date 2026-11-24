import type { ThreadId } from "@meridian/contracts/runtime";
import type { CurrentToolCall, ThreadActivity } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { LiveEventWriter } from "../../threads/index.js";

export async function appendSubagentActivity(input: {
  eventWriter: LiveEventWriter;
  readActivity: (threadId: ThreadId) => Promise<ThreadActivity>;
  parentThreadId: ThreadId;
  childThreadId: string;
}): Promise<bigint> {
  const activity = await input.readActivity(input.parentThreadId);
  return input.eventWriter.appendEvent(input.parentThreadId, {
    type: "subagent.activity",
    childThreadId: input.childThreadId,
    activity,
  });
}

export async function appendSubagentActivityBestEffort(input: {
  eventWriter: LiveEventWriter;
  readActivity: (threadId: ThreadId) => Promise<ThreadActivity>;
  parentThreadId: ThreadId;
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
      correlation: { threadId: input.parentThreadId, childRunId: input.childThreadId },
      payload: {
        childThreadId: input.childThreadId,
        ...unknownToEventPayload(error),
      },
    });
  }
}

export async function appendSubagentActivityForToolChangeBestEffort(input: {
  recordCurrentTool: () => Promise<boolean>;
  currentTool: CurrentToolCall;
  eventWriter: LiveEventWriter;
  readActivity: (threadId: ThreadId) => Promise<ThreadActivity>;
  parentThreadId: ThreadId;
  childThreadId: string;
  eventSink: EventSink;
}): Promise<void> {
  try {
    if (!(await input.recordCurrentTool())) return;
  } catch (error) {
    emitEvent(input.eventSink, {
      level: "warn",
      source: "runtime.activity",
      name: "subagent.activity.current_tool_failed",
      correlation: { threadId: input.parentThreadId, childRunId: input.childThreadId },
      payload: {
        childThreadId: input.childThreadId,
        toolCallId: input.currentTool.toolCallId,
        ...unknownToEventPayload(error),
      },
    });
    return;
  }

  await appendSubagentActivityBestEffort({
    eventWriter: input.eventWriter,
    readActivity: input.readActivity,
    parentThreadId: input.parentThreadId,
    childThreadId: input.childThreadId,
    eventSink: input.eventSink,
  });
}

export async function emitRunActivityBestEffort(input: {
  findThread: (
    threadId: ThreadId,
  ) => Promise<{ id: string; kind: string; parentThreadId: string | null } | null>;
  threadId: ThreadId;
  eventWriter: LiveEventWriter;
  readActivity: (threadId: ThreadId) => Promise<ThreadActivity>;
  eventSink: EventSink;
}): Promise<void> {
  try {
    const thread = await input.findThread(input.threadId);
    if (thread?.kind !== "subagent" || !thread.parentThreadId) return;
    await appendSubagentActivityBestEffort({
      eventWriter: input.eventWriter,
      readActivity: input.readActivity,
      parentThreadId: thread.parentThreadId as ThreadId,
      childThreadId: thread.id,
      eventSink: input.eventSink,
    });
  } catch (error) {
    emitEvent(input.eventSink, {
      level: "warn",
      source: "runtime.activity",
      name: "subagent.activity.emit_failed",
      correlation: { threadId: input.threadId },
      payload: { threadId: input.threadId, ...unknownToEventPayload(error) },
    });
  }
}

export function createSubagentActivityRefresher(
  deps: Omit<Parameters<typeof emitRunActivityBestEffort>[0], "threadId">,
) {
  return (threadId: ThreadId) => emitRunActivityBestEffort({ ...deps, threadId });
}
