import { describe, expect, it } from "vitest";
import { system, user } from "../../helpers/messages.js";
import { toOpenAIChatCompletionParams } from "./request-map.js";

describe("toOpenAIChatCompletionParams prompt-cache passthrough", () => {
  it("keeps plain string content and no top-level cache_control when nothing is marked", () => {
    const params = toOpenAIChatCompletionParams(
      { messages: [system("You are Writer."), user("Hello.")] },
      "anthropic/claude-sonnet-4",
    );
    expect(params.messages[0]).toEqual({ role: "system", content: "You are Writer." });
    expect(params.messages[1]).toEqual({ role: "user", content: "Hello." });
    expect(params).not.toHaveProperty("cache_control");
  });

  it("emits an explicit OpenRouter-style cache_control on the marked system part, plus a top-level automatic mark", () => {
    const params = toOpenAIChatCompletionParams(
      {
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: "You are Writer.", cacheBreakpoint: true }],
          },
          {
            role: "user",
            content: [
              { type: "text", text: "History line one." },
              { type: "text", text: "History line two.", cacheBreakpoint: true },
            ],
          },
        ],
      },
      "anthropic/claude-sonnet-4",
    );
    expect(params.messages[0]).toEqual({
      role: "system",
      content: [
        { type: "text", text: "You are Writer.", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
    });
    // The user message's mark is deliberately unread here: OpenRouter's
    // automatic top-level marker below does that job for the rest of the
    // conversation, so a plain user message never needs a per-part mark.
    expect(params.messages[1]).toEqual({
      role: "user",
      content: "History line one.History line two.",
    });
    expect(params).toMatchObject({ cache_control: { type: "ephemeral", ttl: "1h" } });
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
    );
    expect(params.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: JSON.stringify({ ok: true }),
    });
  });

  it("keeps plain string content on a tool-result message with no mark", () => {
    const params = toOpenAIChatCompletionParams(
      {
        messages: [
          {
            role: "tool",
            content: [{ type: "tool_result", toolCallId: "call_1", output: "done" }],
          },
        ],
      },
      "anthropic/claude-sonnet-4",
    );
    expect(params.messages[0]).toEqual({ role: "tool", tool_call_id: "call_1", content: "done" });
  });
});
