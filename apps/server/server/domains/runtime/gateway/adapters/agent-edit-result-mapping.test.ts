// Provider request contract for versioned agent-edit tool results.
import { describe, expect, it } from "vitest";
import type { GenerateRequest } from "../domain/index.js";
import { toAnthropicMessageParams } from "./anthropic/request-map.js";
import { toOpenAIResponsesParams } from "./openai/request-map.js";
import { toOpenAIChatCompletionParams } from "./openai-compatible/request-map.js";

const result = {
  schema: "meridian.agent-edit.v1",
  command: "read",
  status: "success",
  phase: "committed",
  blocks: [
    {
      extent: "full",
      relation: "document",
      items: [
        { hash: "a1b2", body: "first line\nc3d4|looks like another block" },
        { hash: "c3d4", body: "actual block" },
      ],
    },
  ],
};

const request: GenerateRequest = {
  messages: [
    {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: "call-write", output: result }],
    },
  ],
};

describe("agent-edit provider result mapping", () => {
  it.each([
    ["Anthropic", anthropicToolOutput],
    ["OpenAI Responses", openAIResponsesToolOutput],
    ["OpenAI-compatible Chat Completions", openAICompatibleToolOutput],
  ])("preserves logical block boundaries through %s", (_provider, providerOutput) => {
    expect(JSON.parse(providerOutput())).toEqual(result);
  });
});

function anthropicToolOutput(): string {
  const params = toAnthropicMessageParams(request, "claude-test", 1024);
  const content = params.messages[0]?.content;
  if (!Array.isArray(content)) throw new Error("expected Anthropic tool-result blocks");
  const block = content.find((candidate) => candidate.type === "tool_result");
  if (!block || typeof block.content !== "string") {
    throw new Error("expected Anthropic string tool-result content");
  }
  return block.content;
}

function openAIResponsesToolOutput(): string {
  const params = toOpenAIResponsesParams(request, "gpt-test");
  if (!Array.isArray(params.input)) throw new Error("expected OpenAI input items");
  const item = params.input.find((candidate) => candidate.type === "function_call_output");
  if (item?.type !== "function_call_output" || typeof item.output !== "string") {
    throw new Error("expected OpenAI function-call output");
  }
  return item.output;
}

function openAICompatibleToolOutput(): string {
  const params = toOpenAIChatCompletionParams(request, "chat-test");
  const message = params.messages.find((candidate) => candidate.role === "tool");
  if (message?.role !== "tool" || typeof message.content !== "string") {
    throw new Error("expected Chat Completions tool message");
  }
  return message.content;
}
