/** One stream per event family the turn reducer handles; stores must agree on its turns. */
import type { AGUIEvent } from "@meridian/contracts/protocol";
import { EventType } from "@meridian/contracts/protocol";

export const TURN_FIXTURE_THREAD_ID = "thread-1";
export const TURN_FIXTURE_NOW = "2026-01-02T03:04:05.000Z";

const event = (value: Record<string, unknown>) => value as unknown as AGUIEvent;

const interruptBlock = {
  id: "interrupt-block-1",
  turnId: "turn-1",
  blockType: "custom",
  sequence: 3,
  content: { kind: "ask-question", interrupt: { id: "int-1" }, props: { prompt: "Proceed?" } },
};

/** Run start, text and reasoning deltas, a tool with staged then committed results, an interrupt, finish, then a failed run. */
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
  event({ type: EventType.TOOL_CALL_END, toolCallId: "call-1" }),
  event({ type: EventType.TOOL_CALL_RESULT, toolCallId: "call-1", content: "staged: ch1.md" }),
  event({
    type: EventType.TOOL_CALL_RESULT,
    toolCallId: "call-1",
    content: "committed: ch1.md",
    result: { schema: "meridian.agent-edit.v1", status: "success" },
  }),
  event({
    type: EventType.CUSTOM,
    name: "meridian.block.upserted",
    value: { block: interruptBlock },
  }),
  event({
    type: EventType.CUSTOM,
    name: "meridian.interrupt",
    value: { state: "created", turnId: "turn-1", interruptId: "int-1", blockSequence: 3 },
  }),
  event({
    type: EventType.CUSTOM,
    name: "meridian.interrupt",
    value: {
      state: "resolved",
      turnId: "turn-1",
      interruptId: "int-1",
      blockSequence: 3,
      value: "yes",
      provenance: "user",
    },
  }),
  event({ type: EventType.TEXT_MESSAGE_START, messageId: "m2" }),
  event({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m2", delta: "Done." }),
  event({ type: EventType.TEXT_MESSAGE_END, messageId: "m2" }),
  event({ type: EventType.RUN_FINISHED, runId: "turn-1" }),
  event({ type: EventType.RUN_STARTED, runId: "turn-2" }),
  event({ type: EventType.RUN_ERROR, message: "provider failed" }),
];
