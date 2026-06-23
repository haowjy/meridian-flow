// biome-ignore-all lint/suspicious/noExplicitAny: Test mocks use any to simulate raw SDK events.
import { describe, expect, it } from "vitest";

import type { StreamEvent } from "../../../domain/index.js";
import { mapAnthropicError } from "../errors.js";
import { toAnthropicMessageParams } from "../request-map.js";
import {
  buildGenerateResult,
  createStreamAccumulator,
  eventsFromAnthropicStreamEvent,
  mapStopReason,
  mapUsage,
} from "../stream-collect.js";

// ── Helpers ───────────────────────────────────────────────────────

function collectEvents(...rawEvents: any[]): {
  events: StreamEvent[];
  acc: ReturnType<typeof createStreamAccumulator>;
} {
  const acc = createStreamAccumulator("claude-sonnet-4-20250514", "anthropic");
  const events: StreamEvent[] = [];
  for (const raw of rawEvents) {
    for (const ev of eventsFromAnthropicStreamEvent(raw, acc)) {
      events.push(ev);
    }
  }
  return { events, acc };
}

describe("Anthropic adapter", () => {
  it("merges parallel tool results into one user message after assistant tool uses", () => {
    const request = toAnthropicMessageParams(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "private reasoning is not sent back" },
              {
                type: "tool_use",
                toolCallId: "toolu_a",
                toolName: "read",
                input: { path: "a.txt" },
              },
              {
                type: "tool_use",
                toolCallId: "toolu_b",
                toolName: "list",
                input: { path: "." },
              },
            ],
          },
          {
            role: "tool",
            content: [{ type: "tool_result", toolCallId: "toolu_a", output: "a contents" }],
          },
          {
            role: "tool",
            content: [{ type: "tool_result", toolCallId: "toolu_b", output: ["b.txt"] }],
          },
        ],
      },
      "claude-sonnet-4-20250514",
      1024,
    );

    expect(request.messages.map((message) => message.role)).toEqual(["assistant", "user"]);

    const assistantContent = request.messages[0]?.content;
    expect(Array.isArray(assistantContent)).toBe(true);
    if (!Array.isArray(assistantContent)) throw new Error("assistant content should be blocks");
    expect(assistantContent.map((block) => block.type)).toEqual(["tool_use", "tool_use"]);

    const userContent = request.messages[1]?.content;
    expect(Array.isArray(userContent)).toBe(true);
    if (!Array.isArray(userContent)) throw new Error("user content should be blocks");
    expect(userContent.map((block) => block.type)).toEqual(["tool_result", "tool_result"]);
    expect(userContent.map((block) => (block as any).tool_use_id)).toEqual(["toolu_a", "toolu_b"]);
  });

  it("emits start-implied text deltas and builds result", () => {
    const { events, acc } = collectEvents(
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet-4-20250514",
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          container: null,
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            cache_creation: null,
            inference_geo: null,
            output_tokens_details: null,
            server_tool_use: null,
            service_tier: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " world" },
      },
      {
        type: "content_block_stop",
        index: 0,
      },
      {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null,
          stop_details: null,
          container: null,
        },
        usage: {
          output_tokens: 5,
          input_tokens: null,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          output_tokens_details: null,
          server_tool_use: null,
        },
      },
      { type: "message_stop" },
    );

    // Should have text deltas and usage
    const textDeltas = events.filter((e) => e.type === "text.delta");
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0]).toEqual({ type: "text.delta", text: "Hello", partIndex: 0 });
    expect(textDeltas[1]).toEqual({ type: "text.delta", text: " world", partIndex: 0 });

    const usageEvents = events.filter((e) => e.type === "usage");
    expect(usageEvents).toHaveLength(1);

    // Build result
    const result = buildGenerateResult(acc);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: "Hello world" });
    expect(result.finishReason).toBe("end_turn");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.provider).toBe("anthropic");
  });

  it("accumulates tool call deltas and builds result", () => {
    const { events, acc } = collectEvents(
      {
        type: "message_start",
        message: {
          id: "msg_2",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet-4-20250514",
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          container: null,
          usage: {
            input_tokens: 20,
            output_tokens: 0,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            cache_creation: null,
            inference_geo: null,
            output_tokens_details: null,
            server_tool_use: null,
            service_tier: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_123",
          name: "get_weather",
          input: {},
          caller: { type: "direct" },
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"loc' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: 'ation":"SF"}' },
      },
      {
        type: "content_block_stop",
        index: 0,
      },
      {
        type: "message_delta",
        delta: {
          stop_reason: "tool_use",
          stop_sequence: null,
          stop_details: null,
          container: null,
        },
        usage: {
          output_tokens: 12,
          input_tokens: null,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          output_tokens_details: null,
          server_tool_use: null,
        },
      },
      { type: "message_stop" },
    );

    const toolDeltas = events.filter((e) => e.type === "tool_call.delta");
    expect(toolDeltas).toHaveLength(2);
    expect(toolDeltas[0]).toMatchObject({
      type: "tool_call.delta",
      id: "toolu_123",
      name: "get_weather",
    });

    const result = buildGenerateResult(acc);
    expect(result.finishReason).toBe("tool_use");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: "toolu_123",
      name: "get_weather",
      arguments: { location: "SF" },
    });
  });

  it("emits reasoning.delta events for thinking blocks", () => {
    const { events, acc } = collectEvents(
      {
        type: "message_start",
        message: {
          id: "msg_3",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet-4-20250514",
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          container: null,
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            cache_creation: null,
            inference_geo: null,
            output_tokens_details: null,
            server_tool_use: null,
            service_tier: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me think..." },
      },
      {
        type: "content_block_stop",
        index: 0,
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "The answer is 42." },
      },
      {
        type: "content_block_stop",
        index: 1,
      },
      {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null,
          stop_details: null,
          container: null,
        },
        usage: {
          output_tokens: 20,
          input_tokens: null,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          output_tokens_details: { thinking_tokens: 15 },
          server_tool_use: null,
        },
      },
      { type: "message_stop" },
    );

    const reasoningDeltas = events.filter((e) => e.type === "reasoning.delta");
    expect(reasoningDeltas).toHaveLength(1);
    expect(reasoningDeltas[0]).toEqual({
      type: "reasoning.delta",
      text: "Let me think...",
      partIndex: 0,
    });

    const result = buildGenerateResult(acc);
    // Should have reasoning part first, then text part
    expect(result.content[0]).toEqual({ type: "reasoning", text: "Let me think..." });
    expect(result.content[1]).toEqual({ type: "text", text: "The answer is 42." });
  });

  it("maps usage details and stop reasons into canonical gateway fields", () => {
    expect(
      mapUsage(
        {
          input_tokens: 100,
          output_tokens: 1,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 30,
          output_tokens_details: { thinking_tokens: 7 },
        } as any,
        {
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens_details: { thinking_tokens: 9 },
        } as any,
      ),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
      reasoningTokens: 9,
    });
    expect(mapStopReason("end_turn")).toBe("end_turn");
    expect(mapStopReason("tool_use")).toBe("tool_use");
    expect(mapStopReason("max_tokens")).toBe("max_tokens");
    expect(mapStopReason("refusal")).toBe("error");
  });

  it("classifies generic Anthropic transport failures for retry policy", () => {
    expect(mapAnthropicError(new TypeError("fetch failed"))).toMatchObject({
      code: "network_error",
      retryable: true,
    });
    expect(mapAnthropicError(new Error("provider exploded"))).toMatchObject({
      code: "provider_error",
      retryable: true,
    });
  });
});
