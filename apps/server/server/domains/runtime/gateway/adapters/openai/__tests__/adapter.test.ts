// biome-ignore-all lint/suspicious/noExplicitAny: Test mocks use any to simulate raw SDK events.
import { describe, expect, it } from "vitest";

import type { StreamEvent } from "../../../domain/index.js";
import { mapOpenAIResponsesError } from "../errors.js";
import {
  buildGenerateResult,
  createStreamAccumulator,
  eventsFromResponseStreamEvent,
  mapResponseStatus,
  mapUsage,
} from "../stream-collect.js";

// ── Helpers ───────────────────────────────────────────────────────

function collectEvents(...rawEvents: any[]): {
  events: StreamEvent[];
  acc: ReturnType<typeof createStreamAccumulator>;
} {
  const acc = createStreamAccumulator("gpt-4o", "openai");
  const events: StreamEvent[] = [];
  for (const raw of rawEvents) {
    for (const ev of eventsFromResponseStreamEvent(raw, acc)) {
      events.push(ev);
    }
  }
  return { events, acc };
}

describe("OpenAI Responses adapter", () => {
  it("emits text deltas and builds result", () => {
    const { events, acc } = collectEvents(
      {
        type: "response.created",
        response: { id: "resp_1", model: "gpt-4o", status: "in_progress" },
        sequence_number: 0,
      },
      {
        type: "response.output_text.delta",
        delta: "Hello",
        item_id: "item_1",
        output_index: 0,
        content_index: 0,
        sequence_number: 1,
      },
      {
        type: "response.output_text.delta",
        delta: " world",
        item_id: "item_1",
        output_index: 0,
        content_index: 0,
        sequence_number: 2,
      },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          model: "gpt-4o",
          status: "completed",
          output: [],
          incomplete_details: null,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
        sequence_number: 3,
      },
    );

    const textDeltas = events.filter((e) => e.type === "text.delta");
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0]).toEqual({ type: "text.delta", text: "Hello", partIndex: 0 });
    expect(textDeltas[1]).toEqual({ type: "text.delta", text: " world", partIndex: 0 });

    const usageEvents = events.filter((e) => e.type === "usage");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const result = buildGenerateResult(acc);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: "Hello world" });
    expect(result.finishReason).toBe("end_turn");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.model).toBe("gpt-4o");
    expect(result.provider).toBe("openai");
  });

  it("accumulates function call deltas and builds result", () => {
    const { events, acc } = collectEvents(
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_abc",
          name: "get_weather",
          arguments: "",
          status: "in_progress",
        },
        output_index: 0,
        sequence_number: 0,
      },
      {
        type: "response.function_call_arguments.delta",
        delta: '{"loc',
        item_id: "fc_1",
        output_index: 0,
        sequence_number: 1,
      },
      {
        type: "response.function_call_arguments.delta",
        delta: 'ation":"SF"}',
        item_id: "fc_1",
        output_index: 0,
        sequence_number: 2,
      },
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_abc",
          name: "get_weather",
          arguments: '{"location":"SF"}',
          status: "completed",
        },
        output_index: 0,
        sequence_number: 3,
      },
      {
        type: "response.completed",
        response: {
          id: "resp_2",
          model: "gpt-4o",
          status: "completed",
          output: [],
          incomplete_details: null,
          usage: {
            input_tokens: 20,
            output_tokens: 12,
            total_tokens: 32,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
        sequence_number: 4,
      },
    );

    const toolDeltas = events.filter((e) => e.type === "tool_call.delta");
    expect(toolDeltas).toHaveLength(2);
    expect(toolDeltas[0]).toMatchObject({
      type: "tool_call.delta",
      id: "call_abc",
      argumentsDelta: '{"loc',
    });

    const result = buildGenerateResult(acc);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: "call_abc",
      name: "get_weather",
      arguments: { location: "SF" },
    });
    expect(result.finishReason).toBe("tool_use");
  });

  it("buffers argument deltas until output_item.added provides the canonical call id", () => {
    const { events, acc } = collectEvents(
      {
        type: "response.function_call_arguments.delta",
        delta: '{"loc',
        item_id: "fc_1",
        output_index: 0,
        sequence_number: 0,
      },
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_abc",
          name: "get_weather",
          arguments: "",
          status: "in_progress",
        },
        output_index: 0,
        sequence_number: 1,
      },
      {
        type: "response.function_call_arguments.delta",
        delta: 'ation":"SF"}',
        item_id: "fc_1",
        output_index: 0,
        sequence_number: 2,
      },
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_abc",
          name: "get_weather",
          arguments: '{"location":"SF"}',
          status: "completed",
        },
        output_index: 0,
        sequence_number: 3,
      },
      {
        type: "response.completed",
        response: {
          id: "resp_2",
          model: "gpt-4o",
          status: "completed",
          output: [],
          incomplete_details: null,
          usage: {
            input_tokens: 20,
            output_tokens: 12,
            total_tokens: 32,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
        sequence_number: 4,
      },
    );

    const toolDeltas = events.filter(
      (event): event is Extract<StreamEvent, { type: "tool_call.delta" }> =>
        event.type === "tool_call.delta",
    );
    expect(toolDeltas).toHaveLength(2);
    expect(new Set(toolDeltas.map((event) => event.id))).toEqual(new Set(["call_abc"]));
    expect(toolDeltas.map((event) => event.argumentsDelta).join("")).toBe('{"location":"SF"}');

    const result = buildGenerateResult(acc);
    expect(result.toolCalls).toEqual([
      { id: "call_abc", name: "get_weather", arguments: { location: "SF" } },
    ]);
    expect(result.content).toContainEqual({
      type: "tool_use",
      toolCallId: "call_abc",
      toolName: "get_weather",
      input: { location: "SF" },
    });
  });

  it("emits reasoning.delta events", () => {
    const { events, acc } = collectEvents(
      {
        type: "response.reasoning.delta",
        delta: { text: "Analyzing the problem..." },
        item_id: "item_1",
        output_index: 0,
        content_index: 0,
        sequence_number: 0,
      },
      {
        type: "response.output_text.delta",
        delta: "The answer is 42.",
        item_id: "item_2",
        output_index: 1,
        content_index: 0,
        sequence_number: 1,
      },
      {
        type: "response.completed",
        response: {
          id: "resp_3",
          model: "gpt-4o",
          status: "completed",
          output: [],
          incomplete_details: null,
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            total_tokens: 30,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 10 },
          },
        },
        sequence_number: 2,
      },
    );

    const reasoningDeltas = events.filter((e) => e.type === "reasoning.delta");
    expect(reasoningDeltas).toHaveLength(1);
    expect(reasoningDeltas[0]).toEqual({
      type: "reasoning.delta",
      text: "Analyzing the problem...",
      partIndex: 0,
    });

    const result = buildGenerateResult(acc);
    expect(result.content[0]).toEqual({
      type: "reasoning",
      text: "Analyzing the problem...",
      providerOptions: {
        openai: { itemId: "item_1" },
        meridian: { provider: "openai", model: "gpt-4o" },
      },
    });
    expect(result.content[1]).toEqual({
      type: "text",
      text: "The answer is 42.",
    });
    expect(result.usage.reasoningTokens).toBe(10);
  });

  it("maps usage details and terminal statuses into canonical gateway fields", () => {
    expect(
      mapUsage({
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_tokens_details: { cached_tokens: 30 },
        output_tokens_details: { reasoning_tokens: 7 },
      } as any),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      reasoningTokens: 7,
    });
    expect(mapResponseStatus("completed" as any, undefined, false)).toBe("end_turn");
    expect(mapResponseStatus("completed" as any, undefined, true)).toBe("tool_use");
    expect(mapResponseStatus("incomplete" as any, "max_output_tokens", false)).toBe("max_tokens");
    expect(mapResponseStatus("failed" as any, undefined, false)).toBe("error");
  });

  it("classifies provider errors for retry policy", () => {
    expect(mapOpenAIResponsesError({ status: 401, message: "bad key" })).toMatchObject({
      code: "auth_error",
      retryable: false,
    });
    expect(mapOpenAIResponsesError({ status: 429, message: "slow down" })).toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
    expect(mapOpenAIResponsesError({ status: 500, message: "boom" })).toMatchObject({
      code: "server_error",
      retryable: true,
    });
    expect(mapOpenAIResponsesError(new TypeError("fetch failed"))).toMatchObject({
      code: "network_error",
      retryable: true,
    });
  });
});
