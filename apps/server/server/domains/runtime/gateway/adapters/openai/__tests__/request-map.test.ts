import { describe, expect, it } from "vitest";

import type { GenerateRequest } from "../../../domain/index.js";
import { toOpenAIResponsesParams } from "../request-map.js";

function baseRequest(messages: GenerateRequest["messages"]): GenerateRequest {
  return { messages };
}

describe("OpenAI Responses request mapper", () => {
  it("omits reasoning-only and empty text message inputs", () => {
    const params = toOpenAIResponsesParams(
      baseRequest([
        { role: "user", content: [{ type: "text", text: "question" }] },
        { role: "assistant", content: [{ type: "reasoning", text: "private thought" }] },
        { role: "assistant", content: [{ type: "text", text: "" }] },
      ]),
      "gpt-4o",
    );

    expect(params.input).toHaveLength(1);
    expect(params.input[0]).toMatchObject({ type: "message", role: "user", content: "question" });
  });

  it("keeps tool-only assistant calls and makes empty tool output non-empty", () => {
    const params = toOpenAIResponsesParams(
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
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "call_1", output: "" }],
        },
      ]),
      "gpt-4o",
    );

    expect(params.input).toEqual([
      {
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: '{"path":"/tmp/x"}',
      },
      { type: "function_call_output", call_id: "call_1", output: '""' },
    ]);
  });

  it("replays encrypted reasoning items when provider and model origin match", () => {
    const params = toOpenAIResponsesParams(
      {
        reasoning: { effort: "medium" },
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "private reasoning",
                providerOptions: {
                  openai: { itemId: "rs_1", encrypted: "enc_123" },
                  meridian: { provider: "openai", model: "gpt-4o" },
                },
              },
              { type: "text", text: "visible answer" },
            ],
          },
        ],
      },
      "gpt-4o",
    );

    expect(params.input[0]).toEqual({
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "enc_123",
      summary: [],
    });
    expect(params.include).toEqual(["reasoning.encrypted_content"]);
  });
});
