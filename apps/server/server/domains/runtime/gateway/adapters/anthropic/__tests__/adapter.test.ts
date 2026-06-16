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

// ── Request mapping ───────────────────────────────────────────────

describe("Anthropic adapter – request mapping", () => {
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

  it("merges consecutive same-role user text messages into text blocks", () => {
    const request = toAnthropicMessageParams(
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "first" }] },
          { role: "user", content: [{ type: "text", text: "second" }] },
        ],
      },
      "claude-sonnet-4-20250514",
      1024,
    );

    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]?.role).toBe("user");

    const content = request.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) throw new Error("merged user content should be blocks");
    expect(content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });

  it("keeps the single-tool-call assistant and user tool-result messages adjacent", () => {
    const request = toAnthropicMessageParams(
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                toolCallId: "toolu_single",
                toolName: "read",
                input: { path: "a.txt" },
              },
            ],
          },
          {
            role: "tool",
            content: [{ type: "tool_result", toolCallId: "toolu_single", output: "done" }],
          },
        ],
      },
      "claude-sonnet-4-20250514",
      1024,
    );

    expect(request.messages.map((message) => message.role)).toEqual(["assistant", "user"]);

    const assistantContent = request.messages[0]?.content;
    const userContent = request.messages[1]?.content;
    expect(Array.isArray(assistantContent)).toBe(true);
    expect(Array.isArray(userContent)).toBe(true);
    if (!Array.isArray(assistantContent) || !Array.isArray(userContent)) {
      throw new Error("tool call messages should use block content");
    }
    expect(assistantContent.map((block) => block.type)).toEqual(["tool_use"]);
    expect(userContent.map((block) => block.type)).toEqual(["tool_result"]);
    expect((userContent[0] as any).tool_use_id).toBe("toolu_single");
  });
});

// ── Text stream ───────────────────────────────────────────────────

describe("Anthropic adapter – text stream", () => {
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
});

// ── Source order ─────────────────────────────────────────────────

describe("Anthropic adapter – source order", () => {
  it("keeps text before later reasoning when building the result", () => {
    const { acc } = collectEvents(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Visible first." },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "thinking_delta", thinking: "Reasoning second." },
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
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "First reasoning." },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "First text." },
      },
      {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "tool_use",
          id: "toolu_read",
          name: "read",
          input: {},
          caller: { type: "direct" },
        },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' },
      },
      {
        type: "content_block_delta",
        index: 3,
        delta: { type: "thinking_delta", thinking: "Second reasoning." },
      },
      {
        type: "content_block_delta",
        index: 4,
        delta: { type: "text_delta", text: "Second text." },
      },
    );

    expect(buildGenerateResult(acc).content).toMatchObject([
      { type: "reasoning", text: "First reasoning." },
      { type: "text", text: "First text." },
      { type: "tool_use", toolCallId: "toolu_read", toolName: "read", input: { path: "a.txt" } },
      { type: "reasoning", text: "Second reasoning." },
      { type: "text", text: "Second text." },
    ]);
  });
});

// ── Tool call stream ──────────────────────────────────────────────

describe("Anthropic adapter – tool call stream", () => {
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
});

// ── Usage mapping (cache tokens) ──────────────────────────────────

describe("Anthropic adapter – usage mapping", () => {
  it("maps cache read and write tokens", () => {
    const usage = mapUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    } as any);

    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.cacheWriteTokens).toBe(20);
    expect(usage.cacheReadTokens).toBe(30);
  });

  it("maps reasoning tokens from output_tokens_details", () => {
    const usage = mapUsage({
      input_tokens: 100,
      output_tokens: 200,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: { thinking_tokens: 150 },
      server_tool_use: null,
      service_tier: null,
    } as any);

    expect(usage.outputTokens).toBe(200);
    expect(usage.reasoningTokens).toBe(150);
  });

  it("omits optional fields when zero", () => {
    const usage = mapUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    } as any);

    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(usage.cacheReadTokens).toBeUndefined();
    expect(usage.cacheWriteTokens).toBeUndefined();
    expect(usage.reasoningTokens).toBeUndefined();
  });
});

// ── Finish reason mapping ─────────────────────────────────────────

describe("Anthropic adapter – finish reason mapping", () => {
  it.each([
    ["end_turn", "end_turn"],
    ["tool_use", "tool_use"],
    ["max_tokens", "max_tokens"],
    ["stop_sequence", "stop_sequence"],
    ["refusal", "error"],
    [null, "end_turn"],
    [undefined, "end_turn"],
  ] as const)("maps %s → %s", (input, expected) => {
    expect(mapStopReason(input as any)).toBe(expected);
  });
});

// ── Error mapping ─────────────────────────────────────────────────

describe("Anthropic adapter – error mapping", () => {
  it("maps generic Error to provider_error", () => {
    const result = mapAnthropicError(new Error("something failed"));
    expect(result.code).toBe("provider_error");
    expect(result.retryable).toBe(true);
  });

  it("maps TypeError to network_error", () => {
    const result = mapAnthropicError(new TypeError("fetch failed"));
    expect(result.code).toBe("network_error");
    expect(result.retryable).toBe(true);
  });
});

// ── Reasoning (thinking) deltas ───────────────────────────────────

describe("Anthropic adapter – reasoning stream", () => {
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
});
