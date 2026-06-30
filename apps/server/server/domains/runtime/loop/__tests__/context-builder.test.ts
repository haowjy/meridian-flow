/**
 * Context-builder regression tests: protect the thread-history projection used
 * before provider request mapping. These cases assert assistant tool-use
 * messages are snapshotted before tool results split the turn history.
 */
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";

import { toAnthropicMessageParams } from "../../gateway/adapters/anthropic/request-map.js";
import { toOpenAIResponsesParams } from "../../gateway/adapters/openai/request-map.js";
import type { ContentPart } from "../../gateway/index.js";
import { buildContext, RUNTIME_URI_SYSTEM_INSTRUCTION } from "../context-builder.js";

const createdAt = "2026-06-07T00:00:00.000Z";
const provider = "anthropic";
const model = "claude-sonnet-4-20250514";

function thread(): Thread {
  return {
    id: "thread-1",
    projectId: "project-1",
    workId: null,
    userId: "user-1",
    kind: "primary",
    status: "idle",
    title: null,
    composedSystemPrompt: null,
    systemPrompt: null,
    workingState: null,
    currentAgent: null,
    aiWriteMode: "direct",
    parentThreadId: null,
    rootThreadId: "thread-1",
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 2,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  };
}

function turn(id: string, role: Turn["role"]): Turn {
  return {
    id,
    threadId: "thread-1",
    prevTurnId: null,
    parentTurnId: null,
    role,
    status: "complete",
    finishReason: null,
    model: null,
    provider: null,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalCostUsd: "0",
    responseCount: 0,
    usage: null,
    error: null,
    requestParams: null,
    responseMetadata: null,
    createdAt,
    completedAt: createdAt,
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}

function block(
  id: string,
  turnId: string,
  sequence: number,
  blockType: Block["blockType"],
  content: Block["content"],
  textContent: string | null = null,
): Block {
  return {
    id,
    turnId,
    responseId: "response-1",
    blockType,
    sequence,
    textContent,
    content,
    provider,
    providerData: null,
    executionSide: null,
    status: "complete",
    collapsedContent: null,
    createdAt,
  };
}

function expectArrayContent(
  message: ReturnType<typeof toAnthropicMessageParams>["messages"][number],
) {
  expect(Array.isArray(message.content)).toBe(true);
  if (!Array.isArray(message.content)) {
    throw new Error("Expected Anthropic message content to be an array");
  }
  return message.content;
}

describe("buildContext", () => {
  it("adds kb:// knowledge-base guidance while preserving manuscript:// as the bare-path default", () => {
    const context = buildContext({
      thread: { ...thread(), systemPrompt: "You are a careful research agent." },
      turns: [],
      blocks: [],
    });

    expect(context.messages[0]).toMatchObject({
      role: "system",
      content: [{ type: "text", text: expect.stringContaining(RUNTIME_URI_SYSTEM_INSTRUCTION) }],
    });
    expect(context.messages[0]?.content[0]).toMatchObject({
      text: expect.stringContaining("bare file paths resolve as manuscript://"),
    });
    expect(context.messages[0]?.content[0]).toMatchObject({
      text: expect.stringContaining("Use explicit kb:// URIs"),
    });
  });

  it("injects undo notifications after working state", () => {
    const context = buildContext({
      thread: { ...thread(), workingState: { focus: "chapter" } as never },
      turns: [],
      blocks: [],
      undoNotifications: [
        {
          id: 1,
          threadId: "thread-1" as never,
          writeHandle: "w12",
          turnId: "turn-1" as never,
          uri: "manuscript://arc/chapter-3.mdx",
          direction: "undo",
          createdAt: new Date(createdAt),
        },
        {
          id: 2,
          threadId: "thread-1" as never,
          writeHandle: "w13",
          turnId: "turn-1" as never,
          uri: "manuscript://arc/chapter-3.mdx",
          direction: "undo",
          createdAt: new Date(createdAt),
        },
        {
          id: 3,
          threadId: "thread-1" as never,
          writeHandle: "w14",
          turnId: "turn-1" as never,
          uri: "manuscript://arc/chapter-4.mdx",
          direction: "undo",
          createdAt: new Date(createdAt),
        },
      ],
    });

    expect(context.messages[1]).toMatchObject({
      role: "system",
      content: [{ type: "text", text: expect.stringContaining("Working state:") }],
    });
    expect(context.messages[2]).toMatchObject({
      role: "system",
      content: [
        {
          type: "text",
          text: [
            "The writer reversed the following edits before this message:",
            "- chapter-3.mdx: w12, w13",
            "- chapter-4.mdx: w14",
            "They are signaling these changes were unwanted.",
          ].join("\n"),
        },
      ],
    });
  });

  it("keeps assistant tool_use blocks immediately before same-turn tool_results", () => {
    const userTurn = turn("turn-user", "user");
    const assistantTurn = turn("turn-assistant", "assistant");
    const context = buildContext({
      thread: thread(),
      turns: [userTurn, assistantTurn],
      blocks: [
        block("block-user", userTurn.id, 0, "text", null, "Use both tools."),
        block(
          "block-reasoning",
          assistantTurn.id,
          0,
          "reasoning",
          {
            text: "I need two tools.",
            providerOptions: {
              anthropic: { signature: "sig_parallel_tools" },
              meridian: { provider, model },
            },
          },
          "I need two tools.",
        ),
        block("block-tool-use-a", assistantTurn.id, 1, "tool_use", {
          toolCallId: "toolu_a",
          toolName: "read",
          input: { path: "a.txt" },
        }),
        block("block-tool-use-b", assistantTurn.id, 2, "tool_use", {
          toolCallId: "toolu_b",
          toolName: "read",
          input: { path: "b.txt" },
        }),
        block("block-tool-result-a", assistantTurn.id, 3, "tool_result", {
          toolCallId: "toolu_a",
          output: { text: "A" },
          isError: false,
        }),
        block("block-tool-result-b", assistantTurn.id, 4, "tool_result", {
          toolCallId: "toolu_b",
          output: { text: "B" },
          isError: false,
        }),
      ],
    });

    expect(context.messages.some((message) => message.role === "assistant")).toBe(true);
    expect(
      context.messages.filter(
        (message) => message.role === "assistant" && message.content.length === 0,
      ),
    ).toEqual([]);

    const assistantIndex = context.messages.findIndex((message) => message.role === "assistant");
    expect(assistantIndex).toBeGreaterThan(-1);
    const assistantMessage = context.messages[assistantIndex];
    expect(assistantMessage?.content.map((part) => part.type)).toEqual([
      "reasoning",
      "tool_use",
      "tool_use",
    ]);
    expect(
      assistantMessage?.content
        .filter(
          (part): part is Extract<ContentPart, { type: "tool_use" }> => part.type === "tool_use",
        )
        .map((part) => part.toolCallId),
    ).toEqual(["toolu_a", "toolu_b"]);

    expect(context.messages[assistantIndex + 1]).toMatchObject({
      role: "tool",
      content: [{ type: "tool_result", toolCallId: "toolu_a" }],
    });
    expect(context.messages[assistantIndex + 2]).toMatchObject({
      role: "tool",
      content: [{ type: "tool_result", toolCallId: "toolu_b" }],
    });

    const anthropic = toAnthropicMessageParams(
      { messages: context.messages },
      model,
      4096,
      provider,
    );

    expect(anthropic.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    const anthropicAssistantContent = expectArrayContent(anthropic.messages[1]);
    expect(anthropicAssistantContent.map((part) => part.type)).toEqual([
      "thinking",
      "tool_use",
      "tool_use",
    ]);
    expect(
      anthropicAssistantContent
        .filter((part) => part.type === "tool_use")
        .map((part) => ("id" in part ? part.id : null)),
    ).toEqual(["toolu_a", "toolu_b"]);

    const anthropicToolResultContent = expectArrayContent(anthropic.messages[2]);
    expect(anthropicToolResultContent.map((part) => part.type)).toEqual([
      "tool_result",
      "tool_result",
    ]);
    expect(
      anthropicToolResultContent
        .filter((part) => part.type === "tool_result")
        .map((part) => ("tool_use_id" in part ? part.tool_use_id : null)),
    ).toEqual(["toolu_a", "toolu_b"]);
  });

  it("filters custom blocks from model context and skips all-custom assistant messages", () => {
    const assistantTurn = turn("turn-assistant", "assistant");
    const context = buildContext({
      thread: thread(),
      turns: [assistantTurn],
      blocks: [
        block("block-active", assistantTurn.id, 0, "custom", {
          kind: "choice",
          props: {
            question: "Which analysis should I run?",
            options: [{ value: "quick", label: "Quick scan" }],
            recommended: "quick",
            requiresHuman: false,
          },
          checkpoint: { id: "checkpoint-active", timeoutMs: 270_000 },
          label: "Which analysis should I run?",
        }),
        block("block-resolved", assistantTurn.id, 1, "custom", {
          kind: "free-text",
          props: {
            question: "What threshold should I use?",
            recommended: null,
            requiresHuman: true,
            resolvedValue: "0.8",
            answerProvenance: "user",
          },
          checkpoint: { id: "checkpoint-resolved", timeoutMs: 270_000 },
          label: "What threshold should I use?",
        }),
        block("block-non-checkpoint", assistantTurn.id, 2, "custom", {
          kind: "chart",
          props: { title: "Not for the model" },
        }),
      ],
    });

    expect(context.messages.filter((message) => message.role === "assistant")).toEqual([]);
    expect(JSON.stringify(context.messages)).not.toContain("Checkpoint");
  });

  it("keeps resolved ask_user tool_use and tool_result adjacent despite the UI checkpoint block", () => {
    const assistantTurn = turn("turn-assistant", "assistant");
    const context = buildContext({
      thread: thread(),
      turns: [assistantTurn],
      blocks: [
        block("block-tool-use", assistantTurn.id, 0, "tool_use", {
          toolCallId: "call-ask-user",
          toolName: "ask_user",
          input: {
            question: "Which analysis should I run?",
            kind: "choice",
            options: [{ value: "quick", label: "Quick scan" }],
            recommended: "quick",
          },
        }),
        block("block-checkpoint-ui", assistantTurn.id, 1, "custom", {
          kind: "choice",
          props: {
            question: "Which analysis should I run?",
            options: [{ value: "quick", label: "Quick scan" }],
            recommended: "quick",
            requiresHuman: false,
            resolvedValue: "quick",
            answerProvenance: "user",
          },
          checkpoint: { id: "checkpoint-resolved", timeoutMs: 270_000 },
          label: "Which analysis should I run?",
        }),
        block("block-tool-result", assistantTurn.id, 2, "tool_result", {
          toolCallId: "call-ask-user",
          output: { value: "quick", provenance: "user" },
          isError: false,
        }),
      ],
    });

    const assistantIndex = context.messages.findIndex((message) => message.role === "assistant");
    expect(assistantIndex).toBeGreaterThan(-1);
    expect(context.messages[assistantIndex]?.content).toEqual([
      {
        type: "tool_use",
        toolCallId: "call-ask-user",
        toolName: "ask_user",
        input: {
          question: "Which analysis should I run?",
          kind: "choice",
          options: [{ value: "quick", label: "Quick scan" }],
          recommended: "quick",
        },
      },
    ]);
    expect(context.messages[assistantIndex + 1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId: "call-ask-user",
          output: { value: "quick", provenance: "user" },
          isError: false,
        },
      ],
    });
    expect(JSON.stringify(context.messages)).not.toContain("Checkpoint resolved");

    const anthropic = toAnthropicMessageParams(
      { messages: context.messages },
      model,
      4096,
      provider,
    );
    expect(anthropic.messages.map((message) => message.role)).toEqual(["assistant", "user"]);
    const anthropicAssistantContent = expectArrayContent(anthropic.messages[0]);
    expect(anthropicAssistantContent).toMatchObject([
      { type: "tool_use", id: "call-ask-user", name: "ask_user" },
    ]);
    expect(anthropicAssistantContent.map((part) => part.type)).toEqual(["tool_use"]);
    const anthropicToolResultContent = expectArrayContent(anthropic.messages[1]);
    expect(anthropicToolResultContent).toMatchObject([
      { type: "tool_result", tool_use_id: "call-ask-user" },
    ]);
    expect(anthropicToolResultContent.map((part) => part.type)).toEqual(["tool_result"]);

    const openai = toOpenAIResponsesParams({ messages: context.messages }, "gpt-5", "openai");
    expect(
      Array.isArray(openai.input)
        ? openai.input.map((item) => ("type" in item ? item.type : null))
        : [],
    ).toEqual(["function_call", "function_call_output"]);
    expect(openai.input).toMatchObject([
      { type: "function_call", call_id: "call-ask-user", name: "ask_user" },
      { type: "function_call_output", call_id: "call-ask-user" },
    ]);
  });
});
