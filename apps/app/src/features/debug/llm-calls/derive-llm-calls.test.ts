/** Contract tests for the gateway EventRecord to LLM-call projection. */
import type { EventRecord } from "@meridian/contracts/observability";
import { describe, expect, it } from "vitest";

import { deriveLlmCalls } from "./derive-llm-calls";

function event(
  callId: string,
  observerSeq: number,
  name: string,
  overrides: Partial<EventRecord> = {},
): EventRecord {
  return {
    eventId: `${callId}-${observerSeq}`,
    timestamp: `2026-07-18T12:00:0${observerSeq}.000Z`,
    level: "debug",
    source: "gateway",
    name,
    correlation: {
      gatewayCallId: callId,
      provider: "anthropic",
      model: "claude-sonnet",
      threadId: "thread-1",
      turnId: "turn-1",
      iteration: 2,
    },
    stream: {
      streamId: `gateway:${callId}`,
      transport: "gateway",
      observedAt: "server",
      observerSeq,
    },
    payload: {},
    ...overrides,
  };
}

describe("deriveLlmCalls", () => {
  it("groups calls, derives metrics, and orders calls newest-first", () => {
    const records = [
      event("older", 3, "stream.close", {
        timestamp: "2026-07-18T12:00:03.000Z",
        payload: {
          outcome: "ok",
          durationMs: 300,
          firstOutputMs: 40,
          inputTokens: 100,
          outputTokens: 20,
        },
      }),
      event("newer", 1, "stream.open", { timestamp: "2026-07-18T12:01:00.000Z" }),
      event("older", 1, "stream.open", { timestamp: "2026-07-18T12:00:00.000Z" }),
      event("older", 2, "stream.first_output", {
        timestamp: "2026-07-18T12:00:01.000Z",
        payload: { latencyMs: 41 },
      }),
    ];

    const calls = deriveLlmCalls(records);

    expect(calls.map(({ gatewayCallId }) => gatewayCallId)).toEqual(["newer", "older"]);
    expect(calls[0]).toMatchObject({ outcome: "in-flight" });
    expect(calls[1]).toMatchObject({
      outcome: "ok",
      durationMs: 300,
      firstOutputMs: 40,
      inputTokens: 100,
      outputTokens: 20,
      provider: "anthropic",
      model: "claude-sonnet",
      threadId: "thread-1",
      turnId: "turn-1",
      iteration: 2,
    });
    expect(calls[1]?.lifecycleEvents.map(({ name }) => name)).toEqual([
      "stream.open",
      "stream.first_output",
      "stream.close",
    ]);
  });

  it("uses error over cancelled over ok when duplicate terminal records are retained", () => {
    const records = [
      event("call", 1, "stream.open"),
      event("call", 2, "stream.close", { payload: { outcome: "ok", durationMs: 20 } }),
      event("call", 3, "stream.close", {
        payload: { outcome: "cancelled", durationMs: 30 },
      }),
      event("call", 4, "stream.close", { payload: { outcome: "error", durationMs: 40 } }),
    ];

    expect(deriveLlmCalls(records)[0]).toMatchObject({ outcome: "error", durationMs: 40 });
    expect(deriveLlmCalls(records.slice(0, 3))[0]).toMatchObject({
      outcome: "cancelled",
      durationMs: 30,
    });
  });

  it("marks calls without close as in-flight and falls back to first-output latency", () => {
    const call = deriveLlmCalls([
      event("call", 1, "stream.open"),
      event("call", 2, "stream.first_output", { payload: { latencyMs: 17 } }),
    ])[0];

    expect(call).toMatchObject({ outcome: "in-flight", firstOutputMs: 17 });
    expect(call?.durationMs).toBeUndefined();
  });

  it("summarizes verbose chunks by message class without retaining them in the timeline", () => {
    const records = [
      event("call", 1, "stream.open"),
      event("call", 2, "stream.chunk", {
        stream: {
          streamId: "gateway:call",
          transport: "gateway",
          observedAt: "server",
          observerSeq: 2,
          messageClass: "text.delta",
        },
      }),
      event("call", 3, "stream.chunk", {
        stream: {
          streamId: "gateway:call",
          transport: "gateway",
          observedAt: "server",
          observerSeq: 3,
          messageClass: "tool_call.delta",
        },
      }),
      event("call", 4, "stream.chunk", {
        stream: {
          streamId: "gateway:call",
          transport: "gateway",
          observedAt: "server",
          observerSeq: 4,
          messageClass: "text.delta",
        },
      }),
      event("call", 5, "stream.close", { payload: { outcome: "ok" } }),
    ];

    const call = deriveLlmCalls(records)[0];

    expect(call?.chunkCount).toBe(3);
    expect(call?.chunks).toEqual([
      { messageClass: "text.delta", count: 2 },
      { messageClass: "tool_call.delta", count: 1 },
    ]);
    expect(call?.lifecycleEvents.map(({ name }) => name)).toEqual(["stream.open", "stream.close"]);
  });

  it("derives stream-event details from the terminal aggregate without verbose records", () => {
    const call = deriveLlmCalls([
      event("call", 1, "stream.open"),
      event("call", 5, "stream.close", {
        payload: {
          outcome: "ok",
          chunkCount: 4,
          chunkCounts: {
            start: 1,
            "text.delta": 2,
            end: 1,
          },
        },
      }),
    ])[0];

    expect(call?.chunkCount).toBe(4);
    expect(call?.chunks).toEqual([
      { messageClass: "text.delta", count: 2 },
      { messageClass: "end", count: 1 },
      { messageClass: "start", count: 1 },
    ]);
  });

  it("ignores non-gateway records and gateway records without call correlation", () => {
    const wrongSource = event("call", 1, "stream.open", { source: "runtime" });
    const missingCall = event("call", 2, "stream.open", { correlation: {} });

    expect(deriveLlmCalls([wrongSource, missingCall])).toEqual([]);
  });

  describe("untrusted records", () => {
    const validRecord = event("valid", 1, "stream.open");

    it.each([
      ["a null entry", null],
      ["a missing timestamp", { ...validRecord, timestamp: undefined }],
      ["an invalid timestamp", { ...validRecord, timestamp: "not-a-timestamp" }],
      ["a missing payload", { ...validRecord, payload: undefined }],
      ["a null payload", { ...validRecord, payload: null }],
      ["a non-object payload", { ...validRecord, payload: "invalid" }],
      ["missing correlation", { ...validRecord, correlation: undefined }],
    ])("skips %s", (_label, malformedRecord) => {
      const calls = deriveLlmCalls([malformedRecord, validRecord]);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.gatewayCallId).toBe("valid");
      expect(calls[0]?.lifecycleEvents).toHaveLength(1);
    });

    it.each([
      ["an unknown string", "unexpected"],
      ["a numeric outcome", 500],
      ["a null outcome", null],
    ])("normalizes %s close outcome to error", (_label, outcome) => {
      const call = deriveLlmCalls([event("call", 1, "stream.close", { payload: { outcome } })])[0];

      expect(call).toMatchObject({ gatewayCallId: "call", outcome: "error" });
    });

    it.each([
      [
        "close-only",
        [event("close-only", 1, "stream.close", { payload: { outcome: "ok" } })],
        { gatewayCallId: "close-only", outcome: "ok" },
      ],
      [
        "first-output-only",
        [event("first-output-only", 1, "stream.first_output", { payload: { latencyMs: 12 } })],
        { gatewayCallId: "first-output-only", outcome: "in-flight", firstOutputMs: 12 },
      ],
    ])("preserves a %s lifecycle", (_label, records, expected) => {
      expect(deriveLlmCalls(records)[0]).toMatchObject(expected);
    });

    it("does not throw for two correlated records without timestamps", () => {
      const { timestamp: _firstTimestamp, ...first } = event("call", 1, "stream.open");
      const { timestamp: _secondTimestamp, ...second } = event("call", 2, "stream.first_output");

      expect(deriveLlmCalls([first, second])).toEqual([]);
    });

    it("does not throw for a close record with a null payload", () => {
      expect(deriveLlmCalls([{ ...event("call", 1, "stream.close"), payload: null }])).toEqual([]);
    });

    it.each([null, undefined, {}, "records"])("treats a non-array input as empty", (records) => {
      expect(deriveLlmCalls(records)).toEqual([]);
    });
  });
});
