/**
 * ws-protocol.test — contract coverage for WebSocket frame parsing and encoding.
 *
 * Keeps event fixture coverage broad without introducing client-fabricated UI
 * fields into the typed wire protocol contract.
 */
import { describe, expect, it } from "vitest";

import { type AGUIEvent, EventSchemas, EventType } from "./agui";
import { compareSeq } from "./event-seq";
import type { ThreadLiveState } from "./http-types";
import { encodeWsServerMessage, parseWsClientMessage, parseWsServerMessage } from "./ws-protocol";

const EXPECTED_EVENT_TYPES: EventType[] = [
  EventType.TEXT_MESSAGE_START,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_END,
  EventType.TEXT_MESSAGE_CHUNK,
  EventType.TOOL_CALL_START,
  EventType.TOOL_CALL_ARGS,
  EventType.TOOL_CALL_END,
  EventType.TOOL_CALL_CHUNK,
  EventType.TOOL_CALL_RESULT,
  EventType.THINKING_START,
  EventType.THINKING_END,
  EventType.THINKING_TEXT_MESSAGE_START,
  EventType.THINKING_TEXT_MESSAGE_CONTENT,
  EventType.THINKING_TEXT_MESSAGE_END,
  EventType.STATE_SNAPSHOT,
  EventType.STATE_DELTA,
  EventType.MESSAGES_SNAPSHOT,
  EventType.ACTIVITY_SNAPSHOT,
  EventType.ACTIVITY_DELTA,
  EventType.RAW,
  EventType.CUSTOM,
  EventType.RUN_STARTED,
  EventType.RUN_FINISHED,
  EventType.RUN_ERROR,
  EventType.STEP_STARTED,
  EventType.STEP_FINISHED,
  EventType.REASONING_START,
  EventType.REASONING_MESSAGE_START,
  EventType.REASONING_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_END,
  EventType.REASONING_MESSAGE_CHUNK,
  EventType.REASONING_END,
  EventType.REASONING_ENCRYPTED_VALUE,
];

const LIVE_STATE_FIXTURE: ThreadLiveState = {
  threadId: "thread_1",
  status: "active",
  runningTurnId: null,
  currentAgent: null,
  nextSeq: "0",
  resumeAfterSeq: "0",
};

function makeEventFixture(type: EventType): AGUIEvent {
  switch (type) {
    case EventType.TEXT_MESSAGE_START:
      return EventSchemas.parse({ type, messageId: "msg_1" });
    case EventType.TEXT_MESSAGE_CONTENT:
      return EventSchemas.parse({ type, messageId: "msg_1", delta: "Hello" });
    case EventType.TEXT_MESSAGE_END:
      return EventSchemas.parse({ type, messageId: "msg_1" });
    case EventType.TEXT_MESSAGE_CHUNK:
      return EventSchemas.parse({ type, messageId: "msg_1", delta: "Hello" });
    case EventType.TOOL_CALL_START:
      return EventSchemas.parse({ type, toolCallId: "tool_1", toolCallName: "search" });
    case EventType.TOOL_CALL_ARGS:
      return EventSchemas.parse({ type, toolCallId: "tool_1", delta: "{}" });
    case EventType.TOOL_CALL_END:
      return EventSchemas.parse({ type, toolCallId: "tool_1" });
    case EventType.TOOL_CALL_CHUNK:
      return EventSchemas.parse({
        type,
        toolCallId: "tool_1",
        toolCallName: "search",
        delta: "{}",
      });
    case EventType.TOOL_CALL_RESULT:
      return EventSchemas.parse({
        type,
        messageId: "msg_1",
        toolCallId: "tool_1",
        content: "done",
      });
    case EventType.THINKING_START:
      return EventSchemas.parse({ type });
    case EventType.THINKING_END:
      return EventSchemas.parse({ type });
    case EventType.THINKING_TEXT_MESSAGE_START:
      return EventSchemas.parse({ type });
    case EventType.THINKING_TEXT_MESSAGE_CONTENT:
      return EventSchemas.parse({ type, delta: "thinking" });
    case EventType.THINKING_TEXT_MESSAGE_END:
      return EventSchemas.parse({ type });
    case EventType.STATE_SNAPSHOT:
      return EventSchemas.parse({ type, snapshot: { status: "streaming" } });
    case EventType.STATE_DELTA:
      return EventSchemas.parse({
        type,
        delta: [{ op: "add", path: "/status", value: "streaming" }],
      });
    case EventType.MESSAGES_SNAPSHOT:
      return EventSchemas.parse({
        type,
        messages: [{ id: "msg_1", role: "user", content: "hello" }],
      });
    case EventType.ACTIVITY_SNAPSHOT:
      return EventSchemas.parse({ type, messageId: "msg_1", activityType: "tool", content: {} });
    case EventType.ACTIVITY_DELTA:
      return EventSchemas.parse({
        type,
        messageId: "msg_1",
        activityType: "tool",
        patch: [{ op: "add", path: "/message", value: "Searching" }],
      });
    case EventType.RAW:
      return EventSchemas.parse({ type, event: { source: "provider" } });
    case EventType.CUSTOM:
      return EventSchemas.parse({ type, name: "meridian.usage", value: { inputTokens: 1 } });
    case EventType.RUN_STARTED:
      return EventSchemas.parse({ type, threadId: "thread_1", runId: "run_1" });
    case EventType.RUN_FINISHED:
      return EventSchemas.parse({ type, threadId: "thread_1", runId: "run_1" });
    case EventType.RUN_ERROR:
      return EventSchemas.parse({ type, message: "oops" });
    case EventType.STEP_STARTED:
      return EventSchemas.parse({ type, stepName: "model_step" });
    case EventType.STEP_FINISHED:
      return EventSchemas.parse({ type, stepName: "model_step" });
    case EventType.REASONING_START:
      return EventSchemas.parse({ type, messageId: "reason_1" });
    case EventType.REASONING_MESSAGE_START:
      return EventSchemas.parse({ type, messageId: "reason_1", role: "reasoning" });
    case EventType.REASONING_MESSAGE_CONTENT:
      return EventSchemas.parse({ type, messageId: "reason_1", delta: "chain" });
    case EventType.REASONING_MESSAGE_END:
      return EventSchemas.parse({ type, messageId: "reason_1" });
    case EventType.REASONING_MESSAGE_CHUNK:
      return EventSchemas.parse({ type, messageId: "reason_1", delta: "chain" });
    case EventType.REASONING_END:
      return EventSchemas.parse({ type, messageId: "reason_1" });
    case EventType.REASONING_ENCRYPTED_VALUE:
      return EventSchemas.parse({
        type,
        subtype: "message",
        entityId: "reason_1",
        encryptedValue: "secret",
      });
    default: {
      const unreachableType: never = type;
      throw new Error(`Unhandled event fixture for ${String(unreachableType)}`);
    }
  }
}

describe("ws protocol contract", () => {
  it("round-trips RUN_ERROR envelopes on event frames", () => {
    const error = {
      code: "runtime_error",
      message: "model failed",
      retryable: false,
      source: "system" as const,
    };

    expect(
      parseWsServerMessage(
        encodeWsServerMessage({
          type: "event",
          threadId: "thread_1",
          seq: "1",
          event: makeEventFixture(EventType.RUN_ERROR),
          error,
        }),
      ),
    ).toEqual({
      type: "event",
      threadId: "thread_1",
      seq: "1",
      event: makeEventFixture(EventType.RUN_ERROR),
      error,
    });
  });

  it("accepts v1 client lifecycle messages", () => {
    expect(
      parseWsClientMessage(
        JSON.stringify({ type: "subscribe", threadId: "thread_1", lastSeq: "7" }),
      ),
    ).toEqual({ type: "subscribe", threadId: "thread_1", lastSeq: "7" });

    expect(
      parseWsClientMessage(
        JSON.stringify({
          type: "resume",
          subscriptions: [{ threadId: "thread_1", lastSeq: "7" }],
        }),
      ),
    ).toEqual({
      type: "resume",
      subscriptions: [{ threadId: "thread_1", lastSeq: "7" }],
    });

    expect(parseWsClientMessage(JSON.stringify({ type: "pong" }))).toEqual({ type: "pong" });

    expect(
      parseWsClientMessage(
        JSON.stringify({
          type: "checkpoint.respond",
          threadId: "thread_1",
          turnId: "turn_1",
          checkpointId: "checkpoint_1",
          value: { value: "accept" },
        }),
      ),
    ).toEqual({
      type: "checkpoint.respond",
      threadId: "thread_1",
      turnId: "turn_1",
      checkpointId: "checkpoint_1",
      value: { value: "accept" },
    });
  });

  it("rejects compound seq values on client messages", () => {
    expect(
      parseWsClientMessage(
        JSON.stringify({ type: "subscribe", threadId: "thread_1", lastSeq: "10:1" }),
      ),
    ).toBeNull();
  });

  it("orders flat wire seq values", () => {
    expect(compareSeq("9", "10")).toBeLessThan(0);
    expect(compareSeq("10", "9")).toBeGreaterThan(0);
  });

  it("accepts gap messages with v1 causes", () => {
    expect(
      parseWsServerMessage(
        JSON.stringify({
          type: "gap",
          threadId: "thread_1",
          cause: "replay_limit_exceeded",
          fromSeq: "1",
        }),
      ),
    ).toEqual({
      type: "gap",
      threadId: "thread_1",
      cause: "replay_limit_exceeded",
      fromSeq: "1",
    });
  });

  it("accepts sourceThreadId on event frames and subscribed catchup", () => {
    const event = makeEventFixture(EventType.TEXT_MESSAGE_CONTENT);
    expect(
      parseWsServerMessage(
        JSON.stringify({
          type: "event",
          threadId: "thread_root",
          sourceThreadId: "thread_child",
          seq: "10",
          event,
        }),
      ),
    ).toEqual({
      type: "event",
      threadId: "thread_root",
      sourceThreadId: "thread_child",
      seq: "10",
      event,
    });

    expect(
      parseWsServerMessage(
        JSON.stringify({
          type: "subscribed",
          threadId: "thread_root",
          catchup: [{ seq: "10", sourceThreadId: "thread_child", event }],
          state: LIVE_STATE_FIXTURE,
          nextSeq: "11",
        }),
      ),
    ).toEqual({
      type: "subscribed",
      threadId: "thread_root",
      catchup: [{ seq: "10", sourceThreadId: "thread_child", event }],
      state: LIVE_STATE_FIXTURE,
      nextSeq: "11",
    });
  });

  it("accepts every AG-UI event type in event and subscribed catchup frames", () => {
    for (const eventType of Object.values(EventType)) {
      const event = makeEventFixture(eventType);

      expect(
        parseWsServerMessage(
          JSON.stringify({ type: "event", threadId: "thread_1", seq: "7", event }),
        ),
      ).toEqual({ type: "event", threadId: "thread_1", seq: "7", event });

      expect(
        parseWsServerMessage(
          JSON.stringify({
            type: "subscribed",
            threadId: "thread_1",
            catchup: [{ seq: "7", event }],
            state: LIVE_STATE_FIXTURE,
            nextSeq: "8",
          }),
        ),
      ).toEqual({
        type: "subscribed",
        threadId: "thread_1",
        catchup: [{ seq: "7", event }],
        state: LIVE_STATE_FIXTURE,
        nextSeq: "8",
      });
    }
  });

  it("round-trips structured server MeridianError frames and rejects malformed envelopes", () => {
    const encoded = encodeWsServerMessage({
      type: "error",
      kind: "error",
      error: {
        code: "forbidden",
        message: "Forbidden",
        retryable: false,
        source: "system",
      },
    });

    expect(parseWsServerMessage(encoded)).toEqual({
      type: "error",
      kind: "error",
      error: {
        code: "forbidden",
        message: "Forbidden",
        retryable: false,
        source: "system",
      },
    });
    expect(
      parseWsServerMessage(
        JSON.stringify({
          type: "error",
          kind: "error",
          error: { code: "forbidden", message: "Forbidden" },
        }),
      ),
    ).toBeNull();
  });

  it("accepts typed checkpoint rejection MeridianError frames", () => {
    expect(
      parseWsServerMessage(
        JSON.stringify({
          type: "error",
          kind: "error",
          error: {
            code: "checkpoint_not_pending",
            message: "No pending checkpoint",
            retryable: false,
            source: "system",
          },
          threadId: "thread_1",
        }),
      ),
    ).toEqual({
      type: "error",
      kind: "error",
      error: {
        code: "checkpoint_not_pending",
        message: "No pending checkpoint",
        retryable: false,
        source: "system",
      },
      threadId: "thread_1",
    });
  });

  it("guards against EventType drift", () => {
    expect(Object.values(EventType)).toEqual(EXPECTED_EVENT_TYPES);
  });
});
