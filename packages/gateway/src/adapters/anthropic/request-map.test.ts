/**
 * Tests request map behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Anthropic reasoning, cache, and tool-schema mapping
 */
import { describe, expect, it } from "vitest";
import type { GenerateRequest } from "../../domain/index.js";
import { resolveReasoning } from "../../domain/index.js";
import { assistant, system, text, toolResult, user } from "../../helpers/messages.js";
import { toAnthropicMessageParams } from "./request-map.js";

// DeepSeek's row has a thinking toggle; Claude's has none.
function toParams(
  request: GenerateRequest,
  model: { id: string; maxOutputTokens: number },
  providerId: string,
  cacheTtlSeconds: number | null = null,
) {
  const reasoning =
    providerId === "deepseek"
      ? {
          efforts: ["low", "high", "max"] as const,
          canDisable: true as const,
          thinksByDefault: true as const,
        }
      : { efforts: ["low", "medium", "high", "max"] as const };
  return toAnthropicMessageParams(
    request,
    {
      ...model,
      provider: providerId,
      wire: "anthropic" as const,
      ...(providerId === "anthropic" ? { projectToolSchema: true as const } : {}),
      reasoning,
      promptCache: {
        kind: providerId === "deepseek" ? ("automatic" as const) : ("explicit" as const),
        shortTtlSeconds: cacheTtlSeconds,
        longTtlSeconds: cacheTtlSeconds,
      },
    },
    {
      cacheTtlSeconds,
      longCacheWrites: false,
      reasoning: resolveReasoning(request.reasoning, reasoning),
    },
  );
}

const EPHEMERAL_1H = { type: "ephemeral" as const, ttl: "1h" as const };

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
    promptCacheRetention: "short" as const,
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
      toolResult("call_skill_creative_writing_modes", [
        text(
          JSON.stringify({
            slug: "creative-writing-modes",
            body: "modes body.",
          }),
        ),
      ]),
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
    const params = toParams(
      requestWithToolPair(),
      { id: "deepseek-flash", maxOutputTokens: 256 },
      "deepseek",
    );
    expect(assistantBlocks(params)[0]).toEqual({ type: "thinking", thinking: "" });
    expect(assistantBlocks(params).some((block) => block.type === "tool_use")).toBe(true);
  });

  it("does not invent thinking for Anthropic when reasoning is disabled", () => {
    const params = toParams(
      { ...requestWithToolPair(), reasoning: "disabled" },
      { id: "claude-sonnet-4", maxOutputTokens: 4096 },
      "anthropic",
    );
    expect(assistantBlocks(params).some((block) => block.type === "thinking")).toBe(false);
  });

  it("leaves signed thinking in place", () => {
    const params = toParams(
      {
        promptCacheRetention: "short" as const,
        messages: [
          user("hi"),
          assistant([
            {
              type: "reasoning",
              text: "load it",
              providerOptions: {
                meridian: { provider: "deepseek", model: "deepseek-flash" },
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
          toolResult("call_1", [
            text(JSON.stringify({ slug: "writing-principles", body: "body" })),
          ]),
        ],
        tools: [skillTool],
      },
      { id: "deepseek-flash", maxOutputTokens: 256 },
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
    const params = toParams(
      {
        promptCacheRetention: "short" as const,
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
          toolResult("call_1", [
            text(JSON.stringify({ slug: "writing-principles", body: "body" })),
          ]),
        ],
        tools: [skillTool],
      },
      { id: "deepseek-flash", maxOutputTokens: 256 },
      "deepseek",
    );
    expect(assistantBlocks(params)[0]).toEqual({ type: "thinking", thinking: "" });
  });
});

describe("Anthropic message alternation", () => {
  it("merges adjacent delivery user messages after a tool result", () => {
    const params = toParams(
      {
        promptCacheRetention: "short" as const,
        messages: [
          assistant([
            { type: "tool_use", toolCallId: "call_delivery", toolName: "spawn", input: {} },
          ]),
          toolResult("call_delivery", [text(JSON.stringify({ ok: true }))]),
          user("<system_update>child finished</system_update>"),
          user("writer message one"),
          user("writer message two"),
        ],
      },
      { id: "claude-sonnet-4-5", maxOutputTokens: 256 },
      "anthropic",
      60 * 60,
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

describe("Anthropic prompt-cache marks", () => {
  const sonnet = { id: "claude-sonnet-4-5", maxOutputTokens: 256 };
  const blocksOf = (content: unknown) => (Array.isArray(content) ? content : []);

  it("marks the system block and the last block of the two latest user messages", () => {
    const params = toParams(
      {
        promptCacheRetention: "short" as const,
        messages: [
          system("You are Writer."),
          user("first"),
          assistant([{ type: "tool_use", toolCallId: "c1", toolName: "grep", input: {} }]),
          toolResult("c1", [text("result")], false),
          assistant([{ type: "text", text: "done" }]),
          user("older"),
          assistant([{ type: "tool_use", toolCallId: "c2", toolName: "grep", input: {} }]),
          toolResult("c2", [text("result")], false),
        ],
        tools: [{ type: "function", name: "grep", description: "Search.", inputSchema: {} }],
      },
      sonnet,
      "anthropic",
      60 * 60,
    );
    expect(params.system).toEqual([
      { type: "text", text: "You are Writer.", cache_control: EPHEMERAL_1H },
    ]);
    expect(params.tools?.[0]).not.toHaveProperty("cache_control");
    const marked = params.messages.flatMap((m, i) =>
      blocksOf(m.content).some((b: { cache_control?: unknown }) => b.cache_control) ? [i] : [],
    );
    // Tool results fold into user turns: the final tool_result and the "older" user turn.
    expect(marked).toEqual([params.messages.length - 3, params.messages.length - 1]);
    expect(blocksOf(params.messages.at(-1)?.content).at(-1)).toMatchObject({
      type: "tool_result",
      cache_control: EPHEMERAL_1H,
    });
    expect(blocksOf(params.messages.at(-3)?.content).at(-1)).toMatchObject({
      type: "text",
      text: "older",
      cache_control: EPHEMERAL_1H,
    });
  });

  it("keeps the tail mark when the last user block is an image", () => {
    const params = toParams(
      {
        promptCacheRetention: "short" as const,
        messages: [
          system("You are Writer."),
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "media", mediaType: "image/png", source: { data: "aGk=" } },
            ],
          },
        ],
      },
      sonnet,
      "anthropic",
      60 * 60,
    );
    expect(blocksOf(params.messages[0].content).map((b: { type: string }) => b.type)).toEqual([
      "text",
      "image",
    ]);
    expect(blocksOf(params.messages[0].content)[1]).toMatchObject({
      type: "image",
      cache_control: EPHEMERAL_1H,
    });
  });

  it("sends a joined system string and no cache_control when the model caches automatically", () => {
    const params = toParams(
      { promptCacheRetention: "short" as const, messages: [system("Sys"), user("hi")] },
      { id: "deepseek-flash", maxOutputTokens: 256 },
      "deepseek",
    );
    expect(params.system).toBe("Sys");
    expect(JSON.stringify(params)).not.toContain("cache_control");
  });
});
