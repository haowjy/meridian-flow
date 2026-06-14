import { describe, expect, it } from "vitest";

import type { GenerateRequest } from "../../../domain/index.js";
import { toOpenAIChatCompletionParams } from "../request-map.js";

function baseRequest(messages: GenerateRequest["messages"]): GenerateRequest {
  return { messages };
}

function expectNoEmptyChatMessages(
  messages: ReturnType<typeof toOpenAIChatCompletionParams>["messages"],
) {
  for (const message of messages) {
    const toolCalls = "tool_calls" in message ? message.tool_calls : undefined;
    const content = "content" in message ? message.content : undefined;
    const hasContent = Array.isArray(content) ? content.length > 0 : typeof content === "string";
    expect(Boolean(toolCalls?.length) || (hasContent && content !== "")).toBe(true);
  }
}

describe("OpenAI-compatible request mapper", () => {
  it("omits reasoning-only assistant messages", () => {
    const params = toOpenAIChatCompletionParams(
      baseRequest([
        { role: "user", content: [{ type: "text", text: "question" }] },
        { role: "assistant", content: [{ type: "reasoning", text: "private thought" }] },
      ]),
      "gpt-compatible",
    );

    expect(params.messages).toHaveLength(1);
    expect(params.messages[0]).toMatchObject({ role: "user", content: "question" });
    expectNoEmptyChatMessages(params.messages);
  });

  it("keeps tool-only assistant messages as tool calls", () => {
    const params = toOpenAIChatCompletionParams(
      baseRequest([
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              toolCallId: "call_1",
              toolName: "read_file",
              input: { path: "/tmp/x" },
            },
          ],
        },
      ]),
      "gpt-compatible",
    );

    expect(params.messages).toHaveLength(1);
    expect(params.messages[0]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"/tmp/x"}' },
        },
      ],
    });
    expectNoEmptyChatMessages(params.messages);
  });

  it("serializes empty tool output to non-empty content", () => {
    const params = toOpenAIChatCompletionParams(
      baseRequest([
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "call_1", output: "" }],
        },
      ]),
      "gpt-compatible",
    );

    expect(params.messages).toEqual([{ role: "tool", tool_call_id: "call_1", content: '""' }]);
    expectNoEmptyChatMessages(params.messages);
  });

  it("maps text, tool use, tool result, and final text without empty content messages", () => {
    const params = toOpenAIChatCompletionParams(
      baseRequest([
        { role: "user", content: [{ type: "text", text: "read it" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "I should use a tool." },
            {
              type: "tool_use",
              toolCallId: "call_1",
              toolName: "read_file",
              input: { path: "/tmp/x" },
            },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "call_1", output: "" }],
        },
        { role: "assistant", content: [{ type: "reasoning", text: "Now answer." }] },
        { role: "assistant", content: [{ type: "text", text: "file contents" }] },
      ]),
      "gpt-compatible",
    );

    expect(params.messages).toHaveLength(4);
    expect(params.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expectNoEmptyChatMessages(params.messages);
  });
});
