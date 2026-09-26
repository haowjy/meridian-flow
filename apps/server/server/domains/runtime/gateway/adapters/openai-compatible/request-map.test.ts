import { describe, expect, it } from "vitest";
import { system, user } from "../../helpers/messages.js";
import { toOpenAIChatCompletionParams } from "./request-map.js";

describe("toOpenAIChatCompletionParams prompt-cache passthrough", () => {
  it("keeps plain string content when no part carries cacheControl", () => {
    const params = toOpenAIChatCompletionParams(
      { messages: [system("You are Writer."), user("Hello.")] },
      "anthropic/claude-sonnet-4",
    );
    expect(params.messages[0]).toEqual({ role: "system", content: "You are Writer." });
    expect(params.messages[1]).toEqual({ role: "user", content: "Hello." });
  });

  it("emits an OpenRouter-style cache_control block only on the marked part", () => {
    const params = toOpenAIChatCompletionParams(
      {
        messages: [
          {
            role: "system",
            content: [
              {
                type: "text",
                text: "You are Writer.",
                providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
              },
            ],
          },
          {
            role: "user",
            content: [
              { type: "text", text: "History line one." },
              {
                type: "text",
                text: "History line two.",
                providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
              },
            ],
          },
        ],
      },
      "anthropic/claude-sonnet-4",
    );
    expect(params.messages[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: "You are Writer.", cache_control: { type: "ephemeral" } }],
    });
    expect(params.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "History line one." },
        { type: "text", text: "History line two.", cache_control: { type: "ephemeral" } },
      ],
    });
  });

  it("carries the mark on a tool-result message when it is the request's last message", () => {
    // `applyPromptCacheMarks` marks the frozen system message and whichever
    // message is last; mid tool-loop that is almost always this one. Without
    // this, the tail prompt-cache breakpoint silently never lands for an
    // Anthropic-backed model routed through OpenRouter.
    const params = toOpenAIChatCompletionParams(
      {
        messages: [
          system("You are Writer."),
          {
            role: "tool",
            content: [
              {
                type: "tool_result",
                toolCallId: "call_1",
                output: { ok: true },
                providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
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
      content: [
        { type: "text", text: JSON.stringify({ ok: true }), cache_control: { type: "ephemeral" } },
      ],
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
