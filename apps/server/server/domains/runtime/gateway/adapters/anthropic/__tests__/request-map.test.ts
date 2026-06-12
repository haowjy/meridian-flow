import { describe, expect, it } from "vitest";

import type { GenerateRequest } from "../../../domain/index.js";
import { toAnthropicMessageParams } from "../request-map.js";

function baseRequest(messages: GenerateRequest["messages"]): GenerateRequest {
  return { messages };
}

describe("Anthropic request mapper", () => {
  it("omits reasoning-only and empty text messages", () => {
    const params = toAnthropicMessageParams(
      baseRequest([
        { role: "user", content: [{ type: "text", text: "question" }] },
        { role: "assistant", content: [{ type: "reasoning", text: "private thought" }] },
        { role: "assistant", content: [{ type: "text", text: "" }] },
      ]),
      "claude-sonnet-4-20250514",
      4096,
    );

    expect(params.messages).toEqual([{ role: "user", content: "question" }]);
  });

  it("keeps tool-only assistant calls and makes empty tool results non-empty", () => {
    const params = toAnthropicMessageParams(
      baseRequest([
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              toolCallId: "toolu_1",
              toolName: "read_file",
              input: { path: "/tmp/x" },
            },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "toolu_1", output: "" }],
        },
      ]),
      "claude-sonnet-4-20250514",
      4096,
    );

    expect(params.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "/tmp/x" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '""', is_error: false }],
      },
    ]);
  });
});
