/**
 * Anthropic reasoning replay tests: protect provider-specific thinking block
 * capture, persistence projection, and request remapping across context rebuilds.
 */
// biome-ignore-all lint/suspicious/noExplicitAny: Tests use minimal SDK/thread payloads to assert adapter boundary shapes.

import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { buildContext } from "../../../../loop/context-builder.js";
import { contentPartToBlockInput } from "../../../../loop/streaming.js";
import type { ContentPart, GenerateRequest, StreamEvent } from "../../../domain/index.js";
import { toAnthropicMessageParams } from "../request-map.js";
import {
  buildGenerateResult,
  createStreamAccumulator,
  eventsFromAnthropicStreamEvent,
} from "../stream-collect.js";

const model = "claude-sonnet-4-20250514";
const provider = "anthropic";

function collectEvents(...rawEvents: any[]): {
  events: StreamEvent[];
  acc: ReturnType<typeof createStreamAccumulator>;
} {
  const acc = createStreamAccumulator(model, provider);
  const events: StreamEvent[] = [];
  for (const raw of rawEvents) {
    for (const event of eventsFromAnthropicStreamEvent(raw, acc)) {
      events.push(event);
    }
  }
  return { events, acc };
}

function paramsFor(messages: GenerateRequest["messages"], targetModel = model) {
  return toAnthropicMessageParams({ messages }, targetModel, 4096, provider);
}

function assistantContent(params: ReturnType<typeof paramsFor>) {
  const content = params.messages.find((message) => message.role === "assistant")?.content;
  expect(Array.isArray(content)).toBe(true);
  if (!Array.isArray(content)) throw new Error("assistant content should be block content");
  return content;
}

describe("Anthropic reasoning capture", () => {
  it("preserves thinking signatures and origin from stream capture into the generate result", () => {
    const { events, acc } = collectEvents(
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [],
          model,
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
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "I should inspect the file." },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig_123" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    );

    expect(events).toContainEqual({
      type: "reasoning.delta",
      text: "I should inspect the file.",
      partIndex: 0,
    });

    const result = buildGenerateResult(acc);
    expect(result.content[0]).toEqual({
      type: "reasoning",
      text: "I should inspect the file.",
      providerOptions: {
        anthropic: { signature: "sig_123" },
        meridian: { provider, model },
      },
    });
  });
});

describe("Anthropic reasoning replay", () => {
  const signedReasoning: ContentPart = {
    type: "reasoning",
    text: "I should use the read tool.",
    providerOptions: {
      anthropic: { signature: "sig_abc" },
      meridian: { provider, model },
    },
  };

  it("replays signed reasoning first when provider and model origin match", () => {
    const params = paramsFor([
      {
        role: "assistant",
        content: [
          { type: "text", text: "visible answer" },
          signedReasoning,
          { type: "tool_use", toolCallId: "toolu_1", toolName: "read", input: { path: "a" } },
        ],
      },
    ]);

    const content = assistantContent(params);
    expect(content[0]).toEqual({
      type: "thinking",
      thinking: "I should use the read tool.",
      signature: "sig_abc",
    });
    expect(content.map((block) => block.type)).toEqual(["thinking", "text", "tool_use"]);
  });

  it("keeps replayed thinking first after consecutive assistant messages are merged", () => {
    const params = paramsFor([
      { role: "assistant", content: [{ type: "text", text: "visible answer" }] },
      { role: "assistant", content: [signedReasoning] },
    ]);

    const content = assistantContent(params);
    expect(content.map((block) => block.type)).toEqual(["thinking", "text"]);
  });

  it("drops signed reasoning when replay target model differs from the origin model", () => {
    const params = paramsFor(
      [
        {
          role: "assistant",
          content: [
            signedReasoning,
            { type: "tool_use", toolCallId: "toolu_1", toolName: "read", input: { path: "a" } },
          ],
        },
      ],
      "claude-opus-4-20250514",
    );

    const content = assistantContent(params);
    expect(content.map((block) => block.type)).toEqual(["tool_use"]);
  });

  it("replays redacted thinking when provider and model origin match", () => {
    const params = paramsFor([
      {
        role: "assistant",
        content: [
          { type: "text", text: "visible answer" },
          {
            type: "reasoning",
            text: "",
            providerOptions: {
              anthropic: { redacted: true, data: "redacted_payload" },
              meridian: { provider, model },
            },
          },
        ],
      },
    ]);

    const content = assistantContent(params);
    expect(content[0]).toEqual({ type: "redacted_thinking", data: "redacted_payload" });
  });
});

describe("reasoning persistence round trip", () => {
  it("stores and reloads reasoning providerOptions with signature and origin", () => {
    const reasoning: ContentPart = {
      type: "reasoning",
      text: "I should use a tool.",
      providerOptions: {
        anthropic: { signature: "sig_roundtrip" },
        meridian: { provider, model },
      },
    };

    const blockInput = contentPartToBlockInput(
      reasoning,
      "turn_assistant" as any,
      0,
      "resp_1",
      provider,
    );
    expect(blockInput).not.toBeNull();

    const block: Block = {
      id: "block_1",
      turnId: "turn_assistant",
      responseId: "resp_1",
      blockType: "reasoning",
      sequence: 0,
      textContent: blockInput?.textContent ?? null,
      content: blockInput?.content ?? null,
      provider,
      providerData: null,
      executionSide: null,
      status: "complete",
      collapsedContent: null,
      createdAt: "2026-06-06T00:00:00.000Z",
    };
    const thread = {
      id: "thread_1",
      systemPrompt: null,
      composedSystemPrompt: null,
      workingState: null,
    } as Thread;
    const turn = { id: "turn_assistant", role: "assistant" } as Turn;

    const context = buildContext({ thread, turns: [turn], blocks: [block] });

    expect(context.messages).toContainEqual({
      role: "assistant",
      content: [reasoning],
    });
  });
});
