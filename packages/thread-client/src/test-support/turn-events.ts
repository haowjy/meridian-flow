/** One stream per event family the turn reducer handles; stores must agree on its turns. */
import type { AGUIEvent } from "@meridian/contracts/protocol";
import { EventType } from "@meridian/contracts/protocol";

export const TURN_FIXTURE_THREAD_ID = "thread-1";
export const TURN_FIXTURE_NOW = "2026-01-02T03:04:05.000Z";

const event = (value: Record<string, unknown>) => value as unknown as AGUIEvent;

const lateBlock = (id: string, sequence: number) => ({
  id,
  turnId: "turn-1",
  blockType: "custom",
  sequence,
  content: { kind: "note", props: { text: id } },
});
const upsertEvent = (block: object): AGUIEvent =>
  event({ type: EventType.CUSTOM, name: "meridian.block.upserted", value: { block } });

/** Re-sends the block at sequence 7 unchanged; stores must keep the turn objects they have. */
export const TURN_FIXTURE_REWRITE_EVENT: AGUIEvent = upsertEvent(lateBlock("late-b", 7));

/**
 * Run start, text and reasoning deltas, a tool with staged then committed
 * results, a counter-named block, out-of-order and replaced
 * blocks, finish, then a failed run.
 */
export const TURN_FIXTURE_EVENTS: readonly AGUIEvent[] = [
  event({ type: EventType.RUN_STARTED, runId: "turn-1", rawEvent: { writeMode: "draft" } }),
  event({ type: EventType.TEXT_MESSAGE_START, messageId: "m1" }),
  event({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "Hello " }),
  event({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "world" }),
  event({ type: EventType.TEXT_MESSAGE_END, messageId: "m1" }),
  event({ type: EventType.REASONING_MESSAGE_START, messageId: "turn-1::1" }),
  event({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "turn-1::1", delta: "thinking" }),
  event({ type: EventType.REASONING_MESSAGE_END, messageId: "turn-1::1" }),
  event({ type: EventType.TOOL_CALL_START, toolCallId: "call-1", toolCallName: "read" }),
  event({ type: EventType.TOOL_CALL_ARGS, toolCallId: "call-1", delta: '{"path":' }),
  event({ type: EventType.TOOL_CALL_ARGS, toolCallId: "call-1", delta: '"ch1.md"}' }),
  event({ type: EventType.TOOL_CALL_RESULT, toolCallId: "call-1", content: "staged: ch1.md" }),
  event({
    type: EventType.TOOL_CALL_RESULT,
    toolCallId: "call-1",
    content: "committed: ch1.md",
    result: { schema: "meridian.agent-edit.v1", status: "success" },
  }),
  event({ type: EventType.TOOL_CALL_END, toolCallId: "call-1" }),
  event({ type: EventType.TEXT_MESSAGE_START, messageId: "m2" }),
  event({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m2", delta: "Done." }),
  event({ type: EventType.TEXT_MESSAGE_END, messageId: "m2" }),
  // No message id: the block id comes from the event counter.
  event({ type: EventType.TEXT_MESSAGE_CHUNK, delta: "!" }),
  // Sequence 9 arrives before 7, then a different id replaces 9, then 7 repeats unchanged.
  upsertEvent(lateBlock("late-a", 9)),
  TURN_FIXTURE_REWRITE_EVENT,
  upsertEvent(lateBlock("late-c", 9)),
  TURN_FIXTURE_REWRITE_EVENT,
  event({ type: EventType.RUN_FINISHED, runId: "turn-1" }),
  event({ type: EventType.RUN_STARTED, runId: "turn-2" }),
  event({ type: EventType.RUN_ERROR, message: "provider failed" }),
];
