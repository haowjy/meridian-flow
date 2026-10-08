import { describe, expect, it } from "vitest";
import { toOpenAIChatCompletionParams } from "./request-map.js";

describe("toOpenAIChatCompletionParams prompt-cache passthrough", () => {
  it("uses the registered descriptor TTL for explicit cache marks", () => {
    const params = toOpenAIChatCompletionParams(
      {
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: "You are Writer.", cacheBreakpoint: true }],
          },
        ],
      },
      "anthropic/claude-sonnet-4",
      5 * 60 * 1_000,
    );
    expect(params).toMatchObject({ cache_control: { type: "ephemeral", ttl: "5m" } });
  });

  it("keeps a tool-result message as plain string content even when it is the request's last message", () => {
    // The undocumented tool-role mark (regressed in a past commit) is gone:
    // OpenRouter only documents per-part cache_control on system/user content,
    // and the request-level automatic mark now covers the conversation tail.
    const params = toOpenAIChatCompletionParams(
      {
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: "You are Writer.", cacheBreakpoint: true }],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool_result",
                toolCallId: "call_1",
                output: { ok: true },
                cacheBreakpoint: true,
              },
            ],
          },
        ],
      },
      "anthropic/claude-sonnet-4",
      60 * 60 * 1_000,
    );
    expect(params.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: JSON.stringify({ ok: true }),
    });
  });
});
