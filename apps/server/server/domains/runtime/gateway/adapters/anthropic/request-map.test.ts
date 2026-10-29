/**
 * Tests request map behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Anthropic reasoning, cache, and tool-schema mapping
 */
import { WriteToolInputSchema } from "@meridian/agent-edit/integration";
import { describe, expect, it } from "vitest";
import { WorkCommandSchema } from "../../../tools/core-tools.js";
import { modelToolSchema } from "../../../tools/model-tool-schema.js";
import { assistant, system, toolResult, user } from "../../helpers/messages.js";
import { toAnthropicMessageParams } from "./request-map.js";

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
      "deepseek-flash",
      256,
      "deepseek",
    );
    expect(assistantBlocks(params)[0]).toEqual({ type: "thinking", thinking: "" });
    expect(assistantBlocks(params).some((block) => block.type === "tool_use")).toBe(true);
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
          toolResult("call_1", { slug: "writing-principles", body: "body" }),
        ],
        tools: [skillTool],
      },
      "deepseek-flash",
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
      "deepseek-flash",
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
      "anthropic",
      60 * 60 * 1_000,
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

describe("Anthropic prompt-cache breakpoints", () => {
  it("translates a cacheBreakpoint into ephemeral cache_control with a 1h ttl for system, tool_use, and tool_result blocks", () => {
    const params = toAnthropicMessageParams(
      {
        messages: [
          {
            ...system("You are Writer."),
            content: [{ type: "text", text: "You are Writer.", cacheBreakpoint: true as const }],
          },
          assistant([
            {
              type: "tool_use",
              toolCallId: "call_1",
              toolName: "grep",
              input: {},
              cacheBreakpoint: true,
            },
          ]),
          {
            ...toolResult("call_1", "result", false),
            content: [
              {
                type: "tool_result",
                toolCallId: "call_1",
                output: "result",
                isError: false,
                cacheBreakpoint: true,
              },
            ],
          },
        ],
        tools: [{ type: "function", name: "grep", description: "Search.", inputSchema: {} }],
      },
      "claude-sonnet-4-5",
      256,
      "anthropic",
      60 * 60 * 1_000,
    );
    expect(params.system).toEqual([
      { type: "text", text: "You are Writer.", cache_control: EPHEMERAL_1H },
    ]);
    // Tools are never marked directly (Anthropic renders tools before system,
    // so the system breakpoint above already covers them).
    expect(params.tools?.[0]).not.toHaveProperty("cache_control");
    const assistantMessage = params.messages.find((m) => m.role === "assistant");
    if (!assistantMessage) throw new Error("Expected an assistant message");
    expect(assistantBlocks({ ...params, messages: [assistantMessage] })[0]).toMatchObject({
      type: "tool_use",
      cache_control: EPHEMERAL_1H,
    });
    const toolMessage = params.messages.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((block) => block.type === "tool_result"),
    );
    const toolContent = toolMessage?.content;
    const toolBlock = (Array.isArray(toolContent) ? toolContent : []).find(
      (block: { type: string }) => block.type === "tool_result",
    );
    expect(toolBlock).toMatchObject({ cache_control: EPHEMERAL_1H });
  });
});

it("keeps implicit thinking and cached content unchanged when only the output cap changes", () => {
  const request = {
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Task", cacheBreakpoint: true as const }],
      },
    ],
    reasoning: { effort: "low" as const },
  };
  const original = toAnthropicMessageParams(
    request,
    "claude-sonnet-4-6",
    16384,
    "anthropic",
    3600000,
  );
  const capped = toAnthropicMessageParams(
    { ...request, maxTokens: 4096 + 300 },
    "claude-sonnet-4-6",
    16384,
    "anthropic",
    3600000,
  );
  expect(capped).toEqual({ ...original, max_tokens: 4396 });
});

it("preserves real Work and Write command instructions only when projecting for Anthropic", () => {
  for (const input of [WorkCommandSchema, WriteToolInputSchema]) {
    const inputSchema = modelToolSchema(input);
    const original = structuredClone(inputSchema);
    const request = { messages: [user("Hello")], tools: [{ ...skillTool, inputSchema }] };
    const params = toAnthropicMessageParams(request, "claude-sonnet-4-6", 128_000, "anthropic");
    const advertised = params.tools?.[0] as {
      input_schema: { properties: Record<string, { description: string }>; required: string[] };
    };
    const branches = inputSchema.oneOf as Array<{
      description: string;
      required: string[];
      properties: Record<string, { const?: string; description?: string }>;
    }>;
    for (const branch of branches) {
      const command = branch.properties.command.const;
      const guidance = advertised.input_schema.properties.command.description;
      expect(guidance).toContain(`${command}: ${branch.description}`);
      expect(guidance).toContain(`Required fields: ${branch.required.join(", ")}.`);
      expect(guidance).toContain(`Allowed fields: ${Object.keys(branch.properties).join(", ")}.`);
      for (const [field, schema] of Object.entries(branch.properties)) {
        expect(advertised.input_schema.properties[field].description).toContain(`[${command}]`);
        if (schema.description)
          expect(advertised.input_schema.properties[field].description).toContain(
            schema.description,
          );
      }
    }
    expect(advertised.input_schema).not.toHaveProperty("oneOf");
    const { oneOf, ...root } = inputSchema;
    const anyOfRequest = {
      ...request,
      tools: [{ ...skillTool, inputSchema: { ...root, anyOf: oneOf } }],
    };
    expect(
      toAnthropicMessageParams(anyOfRequest, "claude-sonnet-4-6", 128_000, "anthropic").tools?.[0],
    ).toHaveProperty("input_schema", advertised.input_schema);
    expect(
      toAnthropicMessageParams(request, "deepseek-flash", 65_536, "deepseek").tools?.[0],
    ).toHaveProperty("input_schema", original);
    expect(inputSchema).toEqual(original);
  }
});
