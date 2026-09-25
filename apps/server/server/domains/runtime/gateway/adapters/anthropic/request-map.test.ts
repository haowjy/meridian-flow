import { describe, expect, it } from "vitest";
import { assistant, toolResult, user } from "../../helpers/messages.js";
import { toAnthropicMessageParams } from "./request-map.js";

const skillTool = {
  type: "function" as const,
  name: "skill",
  description: "Load a skill",
  inputSchema: {
    type: "object",
    properties: { slug: { type: "string" } },
    required: ["slug"],
  },
};

function requestWithToolPair() {
  return {
    messages: [
      user("/creative-writing-modes"),
      assistant([
        {
          type: "tool_use" as const,
          toolCallId: "call_skill_creative_writing_modes",
          toolName: "skill",
          input: { slug: "creative-writing-modes" },
        },
      ]),
      toolResult("call_skill_creative_writing_modes", {
        slug: "creative-writing-modes",
        body: "modes body.",
      }),
    ],
    tools: [skillTool],
  };
}

function assistantBlocks(params: ReturnType<typeof toAnthropicMessageParams>) {
  const assistantMessage = params.messages.find((message) => message.role === "assistant");
  const content = assistantMessage?.content;
  return typeof content === "string" ? [{ type: "text" as const, text: content }] : (content ?? []);
}

describe("toAnthropicMessageParams thinking-before-tool_use repair", () => {
  it("prepends empty thinking on DeepSeek when tool_use has none", () => {
    const params = toAnthropicMessageParams(
      requestWithToolPair(),
      "deepseek-v4-flash",
      256,
      "deepseek",
    );
    expect(assistantBlocks(params)[0]).toEqual({ type: "thinking", thinking: "" });
    expect(assistantBlocks(params).some((block) => block.type === "tool_use")).toBe(true);
  });

  it("prepends empty thinking when reasoning is enabled", () => {
    const params = toAnthropicMessageParams(
      { ...requestWithToolPair(), reasoning: { effort: "medium" } },
      "claude-sonnet-4",
      4096,
      "anthropic",
    );
    expect(assistantBlocks(params)[0]).toEqual({ type: "thinking", thinking: "" });
  });

  it("does not invent thinking for Anthropic when reasoning is disabled", () => {
    const params = toAnthropicMessageParams(
      { ...requestWithToolPair(), reasoning: "disabled" },
      "claude-sonnet-4",
      4096,
      "anthropic",
    );
    expect(assistantBlocks(params).some((block) => block.type === "thinking")).toBe(false);
  });

  it("leaves signed thinking in place", () => {
    const params = toAnthropicMessageParams(
      {
        messages: [
          user("hi"),
          assistant([
            {
              type: "reasoning",
              text: "load it",
              providerOptions: {
                meridian: { provider: "deepseek", model: "deepseek-v4-flash" },
                anthropic: { signature: "sig" },
              },
            },
            {
              type: "tool_use",
              toolCallId: "call_1",
              toolName: "skill",
              input: { slug: "writing-principles" },
            },
          ]),
          toolResult("call_1", { slug: "writing-principles", body: "body" }),
        ],
        tools: [skillTool],
      },
      "deepseek-v4-flash",
      256,
      "deepseek",
    );
    expect(assistantBlocks(params)[0]).toMatchObject({
      type: "thinking",
      thinking: "load it",
      signature: "sig",
    });
    expect(assistantBlocks(params).filter((block) => block.type === "thinking")).toHaveLength(1);
  });

  it("fills empty thinking after unsigned reasoning is dropped", () => {
    const params = toAnthropicMessageParams(
      {
        messages: [
          user("hi"),
          assistant([
            { type: "reasoning", text: "from another model" },
            {
              type: "tool_use",
              toolCallId: "call_1",
              toolName: "skill",
              input: { slug: "writing-principles" },
            },
          ]),
          toolResult("call_1", { slug: "writing-principles", body: "body" }),
        ],
        tools: [skillTool],
      },
      "deepseek-v4-flash",
      256,
      "deepseek",
    );
    expect(assistantBlocks(params)[0]).toEqual({ type: "thinking", thinking: "" });
  });
});

describe("Anthropic message alternation", () => {
  it("merges adjacent delivery user messages after a tool result", () => {
    const params = toAnthropicMessageParams(
      {
        messages: [
          assistant([
            { type: "tool_use", toolCallId: "call_delivery", toolName: "spawn", input: {} },
          ]),
          toolResult("call_delivery", { ok: true }),
          user("<system_update>child finished</system_update>"),
          user("writer message one"),
          user("writer message two"),
        ],
      },
      "claude-sonnet-4-5",
      256,
    );
    expect(params.messages.map((message) => message.role)).toEqual(["assistant", "user"]);
    expect(params.messages[1]).toMatchObject({
      content: [
        { type: "tool_result", tool_use_id: "call_delivery" },
        { type: "text", text: "<system_update>child finished</system_update>" },
        { type: "text", text: "writer message one" },
        { type: "text", text: "writer message two" },
      ],
    });
  });
});
