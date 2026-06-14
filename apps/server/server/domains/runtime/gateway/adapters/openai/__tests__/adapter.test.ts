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

// ── Text stream ───────────────────────────────────────────────────

describe("OpenAI Responses adapter – text stream", () => {
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
});

// ── Source order ─────────────────────────────────────────────────

describe("OpenAI Responses adapter – source order", () => {
  it("keeps text before later reasoning when building the result", () => {
    const { acc } = collectEvents(
      {
        type: "response.output_text.delta",
        delta: "Visible first.",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        sequence_number: 0,
      },
      {
        type: "response.reasoning.delta",
        delta: "Reasoning second.",
        item_id: "rs_1",
        output_index: 1,
        sequence_number: 1,
      },
    );

    expect(buildGenerateResult(acc).content.map((part) => part.type)).toEqual([
      "text",
      "reasoning",
    ]);
  });

  it("preserves multi-round reasoning, text, and tool-use order without merging distinct text blocks", () => {
    const { acc } = collectEvents(
      {
        type: "response.reasoning.delta",
        delta: "First reasoning.",
        item_id: "rs_1",
        output_index: 0,
        sequence_number: 0,
      },
      {
        type: "response.output_text.delta",
        delta: "First text.",
        item_id: "msg_1",
        output_index: 1,
        content_index: 0,
        sequence_number: 1,
      },
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_read",
          name: "read",
          arguments: '{"path":"a.txt"}',
          status: "completed",
        },
        output_index: 2,
        sequence_number: 2,
      },
      {
        type: "response.reasoning.delta",
        delta: "Second reasoning.",
        item_id: "rs_2",
        output_index: 3,
        sequence_number: 3,
      },
      {
        type: "response.output_text.delta",
        delta: "Second text.",
        item_id: "msg_2",
        output_index: 4,
        content_index: 0,
        sequence_number: 4,
      },
    );

    expect(buildGenerateResult(acc).content).toMatchObject([
      { type: "reasoning", text: "First reasoning." },
      { type: "text", text: "First text." },
      { type: "tool_use", toolCallId: "call_read", toolName: "read", input: { path: "a.txt" } },
      { type: "reasoning", text: "Second reasoning." },
      { type: "text", text: "Second text." },
    ]);
  });
});

// ── Tool call stream ──────────────────────────────────────────────

describe("OpenAI Responses adapter – tool call stream", () => {
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

  it("reconciles buffered partial arguments with the provider done snapshot", () => {
    const { acc } = collectEvents(
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
        type: "response.function_call_arguments.done",
        arguments: '{"location":"SF"}',
        item_id: "fc_1",
        output_index: 0,
        sequence_number: 2,
      },
      {
        type: "response.completed",
        response: {
          id: "resp_2",
          model: "gpt-4o",
          status: "completed",
          output: [],
          incomplete_details: null,
          usage: null,
        },
        sequence_number: 3,
      },
    );

    expect(buildGenerateResult(acc).toolCalls).toEqual([
      { id: "call_abc", name: "get_weather", arguments: { location: "SF" } },
    ]);
  });
});

// ── Usage mapping (reasoning tokens + cache) ──────────────────────

describe("OpenAI Responses adapter – usage mapping", () => {
  it("maps reasoning tokens", () => {
    const usage = mapUsage({
      input_tokens: 100,
      output_tokens: 200,
      total_tokens: 300,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 150 },
    });

    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(200);
    expect(usage.reasoningTokens).toBe(150);
  });

  it("maps cached input tokens", () => {
    const usage = mapUsage({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens_details: { reasoning_tokens: 0 },
    });

    expect(usage.cacheReadTokens).toBe(40);
  });

  it("omits optional fields when zero", () => {
    const usage = mapUsage({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });

    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(usage.cacheReadTokens).toBeUndefined();
    expect(usage.reasoningTokens).toBeUndefined();
  });
});

// ── Finish reason mapping ─────────────────────────────────────────

describe("OpenAI Responses adapter – response status mapping", () => {
  it("maps completed → end_turn", () => {
    expect(mapResponseStatus("completed", undefined, false)).toBe("end_turn");
  });

  it("maps completed with tool calls → tool_use", () => {
    expect(mapResponseStatus("completed", undefined, true)).toBe("tool_use");
  });

  it("maps incomplete (max_output_tokens) → max_tokens", () => {
    expect(mapResponseStatus("incomplete", "max_output_tokens", false)).toBe("max_tokens");
  });

  it("maps incomplete (content_filter) → error", () => {
    expect(mapResponseStatus("incomplete", "content_filter", false)).toBe("error");
  });

  it("maps failed → error", () => {
    expect(mapResponseStatus("failed", undefined, false)).toBe("error");
  });

  it("maps cancelled → error", () => {
    expect(mapResponseStatus("cancelled", undefined, false)).toBe("error");
  });
});

// ── Error mapping ─────────────────────────────────────────────────

describe("OpenAI Responses adapter – error mapping", () => {
  it("maps 401 to auth_error", () => {
    const err = Object.assign(new Error("Unauthorized"), { status: 401 });
    const result = mapOpenAIResponsesError(err);
    expect(result.code).toBe("auth_error");
    expect(result.retryable).toBe(false);
  });

  it("maps 429 to rate_limited", () => {
    const err = Object.assign(new Error("Too Many Requests"), { status: 429 });
    const result = mapOpenAIResponsesError(err);
    expect(result.code).toBe("rate_limited");
    expect(result.retryable).toBe(true);
  });

  it("maps 500 to server_error", () => {
    const err = Object.assign(new Error("Internal Server Error"), { status: 500 });
    const result = mapOpenAIResponsesError(err);
    expect(result.code).toBe("server_error");
    expect(result.retryable).toBe(true);
  });

  it("maps TypeError to network_error", () => {
    const result = mapOpenAIResponsesError(new TypeError("fetch failed"));
    expect(result.code).toBe("network_error");
    expect(result.retryable).toBe(true);
  });
});

// ── Reasoning (delta) stream ──────────────────────────────────────

describe("OpenAI Responses adapter – reasoning stream", () => {
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

  it("captures reasoning item encrypted content for stateless replay", () => {
    const { acc } = collectEvents(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_1",
          summary: [],
          encrypted_content: "enc_123",
          status: "in_progress",
        },
        sequence_number: 0,
      },
      {
        type: "response.reasoning.done",
        text: "Analyzing the problem...",
        item_id: "rs_1",
        output_index: 0,
        content_index: 0,
        sequence_number: 1,
      },
    );

    const result = buildGenerateResult(acc);
    expect(result.content[0]).toEqual({
      type: "reasoning",
      text: "Analyzing the problem...",
      providerOptions: {
        openai: { itemId: "rs_1", encrypted: "enc_123" },
        meridian: { provider: "openai", model: "gpt-4o" },
      },
    });
  });

  it("captures reasoning encrypted content from the completed response output", () => {
    const { acc } = collectEvents(
      {
        type: "response.reasoning.done",
        text: "Analyzing the problem...",
        item_id: "rs_1",
        output_index: 0,
        content_index: 0,
        sequence_number: 0,
      },
      {
        type: "response.completed",
        response: {
          id: "resp_4",
          model: "gpt-4o",
          status: "completed",
          incomplete_details: null,
          output: [
            {
              type: "reasoning",
              id: "rs_1",
              summary: [],
              encrypted_content: "enc_from_completed",
              status: "completed",
            },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 1 },
          },
        },
        sequence_number: 1,
      },
    );

    const result = buildGenerateResult(acc);
    expect(result.content[0]).toMatchObject({
      providerOptions: {
        openai: { itemId: "rs_1", encrypted: "enc_from_completed" },
      },
    });
  });
});
