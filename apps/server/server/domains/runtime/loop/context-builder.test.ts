/** Saved history projects provider-safe tool groups, system notices, and transcript-only cards. */
import {
  buildInvocationCardContent,
  type InvocationCardProps,
} from "@meridian/contracts/components";
import type { Block, JsonObject, Thread, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import { toAnthropicMessageParams } from "../gateway/adapters/anthropic/request-map.js";
import { toOpenAIResponsesParams } from "../gateway/adapters/openai/request-map.js";
import { toOpenAIChatCompletionParams } from "../gateway/adapters/openai-compatible/request-map.js";
import type { Message } from "../gateway/index.js";
import { invocationCardProps } from "../spawn/spawn-output.js";
import { transcriptSegments } from "../summary/transcript.js";
import { localBlockFromEvent } from "./block-helpers.js";
import { buildContext, turnContextMessages } from "./context-builder.js";
import { planMessageTurns } from "./inbox-context.js";
import { writeModeSwitchNotice, writeModeSwitchTurn } from "./write-mode-switch.js";

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";

function thread(): Thread {
  return {
    id: THREAD_ID,
    projectId: "project-1",
    workId: null,
    aiWriteMode: "direct",
    effectiveAiWriteMode: "direct",
    userId: "user-1",
    kind: "primary",
    status: "idle",
    title: null,
    ref: null,
    initialPromptBakeId: "bake-1" as never,
    agentDefinitionRevisionId: null,
    agentName: null,
    activeLeafTurnId: null,
    parentThreadId: null,
    rootThreadId: THREAD_ID,
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

function turn(role: Turn["role"], id = TURN_ID): Turn {
  return {
    id,
    threadId: THREAD_ID,
    position: 1,
    prevTurnId: null,
    parentTurnId: null,
    role,
    origin: role === "assistant" ? "assistant" : role === "user" ? "writer" : "system",
    writeMode: null,
    status: "complete",
    promptBakeId: null,
    finishReason: "end_turn",
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: "0",
    responseCount: 0,
    usage: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
    blocks: [],
    executionId: null,
    reservedForUserTurnIds: [],
    delivery: null,
    forgottenBy: null,
    siblingIds: [],
    responses: [],
  };
}

function customBlock(content: Block["content"]): Block {
  return {
    id: "block-1",
    turnId: TURN_ID,
    responseId: null,
    blockType: "custom",
    sequence: 0,
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function userMessageTexts(messages: ReturnType<typeof buildContext>["messages"]): string[] {
  return messages
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    );
}

describe("buildContext system-turn history projection", () => {
  const correlation = {
    parentTurnId: "turn-0",
    toolCallId: "spawn-1",
    deliveryMode: "background_notification" as const,
  };
  const runningCard = (): Extract<InvocationCardProps, { terminalAt: null }> =>
    invocationCardProps({
      agent: "critic",
      agentName: "Critic",
      correlation,
      childThreadId: "child-1",
      execution: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      terminalAt: null,
    });

  it("does not add report content from a terminal invocation card", () => {
    const card = runningCard();
    const content = buildInvocationCardContent({
      ...card,
      execution: "execution-1",
      outcome: "failed",
      terminalAt: "2026-01-01T00:01:00.000Z",
    });

    const { messages } = buildContext({
      thread: thread(),
      turns: [turn("system")],
      blocks: [customBlock(content)],
      systemPrompt: "system prompt",
    });

    expect(userMessageTexts(messages)).toEqual([]);
  });
});

it("keeps a durable mode switch in model context when later undo and redo cancel", () => {
  const switched = writeModeSwitchTurn({
    threadId: THREAD_ID as never,
    prevTurnId: null,
    position: 1,
    mode: "draft",
    controlMessageId: "switch-1",
    notice: writeModeSwitchNotice({ archivedAt: null, isNoWork: false }, "draft", false),
  });
  const reversals = planMessageTurns({
    threadId: THREAD_ID as never,
    batch: [],
    notices: (["undo", "redo"] as const).map((direction, id) => ({
      id,
      kind: "undo",
      scope: { kind: "thread", threadId: THREAD_ID },
      message: "",
      data: { uri: "manuscript://Scene", writeHandles: ["w1"], direction },
      createdAt: new Date(id),
    })),
    prevTurnId: switched.turn.id as never,
    prevTurnPosition: 1,
    knownTurnIds: new Set(),
  });
  expect(reversals.turns).toEqual([]);
  expect(reversals.leafTurnId).toBe(switched.turn.id);
  const context = buildContext({
    thread: thread(),
    systemPrompt: "Write stories.",
    turns: [switched.turn, ...reversals.turns],
    blocks: [localBlockFromEvent(switched.block), ...reversals.blocks.map(localBlockFromEvent)],
  });
  const request = JSON.stringify(context.messages);
  expect(request.match(/The writer switched this chat to draft mode\./g)).toHaveLength(1);
  expect(request).not.toContain("reversed");
  expect(request).not.toContain("restored");
});

function savedBlock(
  blockType: Block["blockType"],
  content: Block["content"],
  sequence: number,
  extra: Partial<Block> = {},
): Block {
  return {
    ...customBlock(content),
    id: `saved-${sequence}`,
    blockType,
    sequence,
    ...(blockType === "text" && typeof content === "string" ? { textContent: content } : {}),
    ...extra,
  };
}

function history(blocks: Block[], turns = [turn("assistant")]) {
  return buildContext({ thread: thread(), turns, blocks, systemPrompt: "Write stories." });
}

function assertCompleteToolGroups(messages: Message[]) {
  let pending = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool") {
      expect([...pending]).toEqual([]);
      const calls = message.content.filter((part) => part.type === "tool_use");
      for (const call of calls) {
        expect(message.role).toBe("assistant");
        expect(call.toolCallId.trim()).not.toBe("");
        expect(call.toolName.trim()).not.toBe("");
        expect(call.input).not.toBeNull();
        expect(typeof call.input).toBe("object");
        expect(Array.isArray(call.input)).toBe(false);
      }
      pending = new Set(calls.map((call) => call.toolCallId));
      expect(pending.size).toBe(calls.length);
      continue;
    }
    expect(message.content).toHaveLength(1);
    for (const result of message.content) {
      expect(result.type).toBe("tool_result");
      if (result.type !== "tool_result") continue;
      expect(pending.has(result.toolCallId)).toBe(true);
      pending.delete(result.toolCallId);
      if (result.isError !== undefined) expect(typeof result.isError).toBe("boolean");
    }
  }
  expect([...pending]).toEqual([]);
}

function providerRequests(messages: Message[]) {
  return {
    anthropic: toAnthropicMessageParams({ messages }, "test-model", 1024),
    chat: toOpenAIChatCompletionParams({ messages }, "test-model"),
    responses: toOpenAIResponsesParams({ messages }, "test-model"),
  };
}

function freezeHistory<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeHistory(child);
    Object.freeze(value);
  }
  return value;
}

describe("saved tool history validation", () => {
  const validCall = { toolCallId: "saved-call", toolName: "read", input: { path: "chapter.md" } };
  const validResult = { toolCallId: "saved-call", toolName: "read", output: "visible output" };
  const malformed: {
    label: string;
    blockType: "tool_use" | "tool_result";
    content: Block["content"];
  }[] = [
    ...([null, "scalar content", 7, false, []] as const).flatMap((content) =>
      (["tool_use", "tool_result"] as const).map((blockType) => ({
        label: `${blockType} content ${JSON.stringify(content)}`,
        blockType,
        content: content as Block["content"],
      })),
    ),
    ...([undefined, null, 7, "", " \t\n"] as const).flatMap((toolCallId) =>
      (["tool_use", "tool_result"] as const).map((blockType) => ({
        label: `${blockType} ID ${JSON.stringify(toolCallId)}`,
        blockType,
        content: {
          ...(blockType === "tool_use" ? validCall : validResult),
          ...(toolCallId === undefined ? {} : { toolCallId }),
        } as Block["content"],
        missingId: toolCallId === undefined,
      })),
    ),
    ...([undefined, null, 7, "", " \t\n"] as const).map((toolName) => ({
      label: `tool_use name ${JSON.stringify(toolName)}`,
      blockType: "tool_use" as const,
      content: {
        ...validCall,
        ...(toolName === undefined ? {} : { toolName }),
      } as Block["content"],
      missingName: toolName === undefined,
    })),
    ...([null, "scalar input", false, 7, []] as const).map((input) => ({
      label: `tool_use input ${JSON.stringify(input)}`,
      blockType: "tool_use" as const,
      content: { ...validCall, input } as Block["content"],
    })),
    ...([null, "false", 0] as const).map((isError) => ({
      label: `tool_result isError ${JSON.stringify(isError)}`,
      blockType: "tool_result" as const,
      content: { ...validResult, isError } as Block["content"],
    })),
  ].map((row) => {
    const content = row.content;
    if (content && typeof content === "object" && !Array.isArray(content)) {
      if ("missingId" in row && row.missingId) delete content.toolCallId;
      if ("missingName" in row && row.missingName) delete content.toolName;
    }
    return row;
  });

  it.each(malformed)("demotes malformed $label before provider serialization", ({
    blockType,
    content,
  }) => {
    const blocks = [
      savedBlock("tool_use", blockType === "tool_use" ? content : validCall, 0),
      savedBlock("tool_result", blockType === "tool_result" ? content : validResult, 1),
    ];
    const before = structuredClone(blocks);
    const { messages } = history(blocks);
    assertCompleteToolGroups(messages);
    const diagnostics = messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content)
      .filter((part) => part.type === "text");
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.map((part) => part.text).join("\n")).toMatch(/could not be replayed/i);
    if (blockType === "tool_use") {
      expect(
        messages.flatMap((message) => message.content).filter((part) => part.type === "tool_use"),
      ).toEqual([]);
      expect(messages.some((message) => message.role === "tool")).toBe(false);
    }
    for (const result of messages
      .flatMap((message) => message.content)
      .filter((part) => part.type === "tool_result")) {
      expect(result).toMatchObject({ toolCallId: "saved-call", isError: true });
      expect(result.output).toContain("no result recorded");
    }
    const wire = JSON.stringify(providerRequests(messages));
    expect(wire).not.toContain('"call_id":""');
    expect(wire).not.toContain('"tool_call_id":""');
    expect(blocks).toEqual(before);
  });

  it("preserves legacy defaults, falsy outputs, and signed reasoning without app-only data", () => {
    const outputs = [false, 0, "", null, { count: 0 }, [0, false]];
    const blocks = outputs.flatMap((output, index) => [
      savedBlock("tool_use", { toolCallId: `legacy-${index}`, toolName: "read" }, index * 2),
      savedBlock(
        "tool_result",
        {
          toolCallId: `legacy-${index}`,
          output,
          isError: false,
          result: "PRIVATE_TYPED_RESULT",
          metadata: { secret: "PRIVATE_METADATA" },
          providerData: { secret: "PRIVATE_PROVIDER_DATA" },
        },
        index * 2 + 1,
        { textContent: "must not replace explicit output" },
      ),
    ]);
    blocks.push(
      savedBlock("tool_use", { toolCallId: "text-fallback", toolName: "read" }, 12),
      savedBlock("tool_result", { toolCallId: "text-fallback" }, 13, {
        textContent: "legacy text",
      }),
      savedBlock("tool_use", { toolCallId: "null-fallback", toolName: "read" }, 14),
      savedBlock("tool_result", { toolCallId: "null-fallback" }, 15),
      savedBlock(
        "reasoning",
        {
          text: "exact reasoning bytes",
          providerOptions: {
            meridian: { provider: "anthropic", model: "test-model" },
            anthropic: { signature: "exact-signature" },
          },
        },
        16,
      ),
    );
    const { messages } = history(blocks);
    assertCompleteToolGroups(messages);
    const parts = messages.flatMap((message) => message.content);
    expect(parts.filter((part) => part.type === "tool_use").map((part) => part.input)).toEqual(
      Array.from({ length: 8 }, () => ({})),
    );
    expect(parts.filter((part) => part.type === "tool_result").map((part) => part.output)).toEqual([
      ...outputs,
      "legacy text",
      null,
    ]);
    expect(parts.find((part) => part.type === "reasoning")).toEqual({
      type: "reasoning",
      ...(blocks.at(-1)?.content as JsonObject),
    });
    const wire = providerRequests(messages);
    expect(JSON.stringify(wire.anthropic)).toContain('"signature":"exact-signature"');
    expect(JSON.stringify(wire)).not.toMatch(
      /PRIVATE_TYPED_RESULT|PRIVATE_METADATA|PRIVATE_PROVIDER_DATA/,
    );
  });

  it("keeps mixed parallel results contiguous, repairs missing results, and scopes reused IDs locally", () => {
    const blocks = [
      savedBlock("tool_use", { toolCallId: "good", toolName: "read", input: {} }, 0),
      savedBlock("tool_use", { toolCallId: "bad", toolName: "", input: {} }, 1),
      savedBlock("tool_use", { toolCallId: "missing", toolName: "read", input: {} }, 2),
      savedBlock("tool_result", { toolCallId: "bad", output: "demoted output" }, 3),
      savedBlock("tool_result", { toolCallId: "good", output: "first result" }, 4),
      savedBlock("text", "Continue after results.", 5),
      savedBlock("tool_use", { toolCallId: "bad", toolName: "read", input: { path: "next" } }, 6),
      savedBlock("tool_result", { toolCallId: "bad", output: "later valid result" }, 7),
    ];
    const { messages } = history(blocks, [{ ...turn("assistant"), status: "cancelled" }]);
    assertCompleteToolGroups(messages);
    const parts = messages.flatMap((message) => message.content);
    expect(parts.filter((part) => part.type === "tool_use").map((part) => part.toolCallId)).toEqual(
      ["good", "missing", "bad"],
    );
    expect(
      parts
        .filter((part) => part.type === "tool_result")
        .map((part) => [part.toolCallId, part.output]),
    ).toEqual([
      ["good", "first result"],
      ["missing", expect.stringContaining("Tool call cancelled; no result recorded.")],
      ["bad", "later valid result"],
    ]);
    const { chat, anthropic, responses } = providerRequests(messages);
    expect(
      chat.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.tool_call_id),
    ).toEqual(["good", "missing", "bad"]);
    const anthropicResults = anthropic.messages
      .flatMap((message) => (typeof message.content === "string" ? [] : message.content))
      .filter((part) => part.type === "tool_result");
    expect(anthropicResults.map((part) => part.tool_use_id)).toEqual(["good", "missing", "bad"]);
    expect(responses.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call",
          call_id: "good",
          name: "read",
          arguments: "{}",
        }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "bad",
          output: "later valid result",
        }),
      ]),
    );
  });

  it("never emits orphan or duplicate true results and allows the same ID in later groups", () => {
    const blocks = [
      savedBlock("tool_result", { toolCallId: "orphan", output: "orphan result" }, 0),
      savedBlock("tool_use", { toolCallId: "duplicate", toolName: "read", input: {} }, 1),
      savedBlock("tool_use", { toolCallId: "duplicate", toolName: "read", input: {} }, 2),
      savedBlock("tool_result", { toolCallId: "duplicate", output: "ambiguous result" }, 3),
      savedBlock("tool_use", { toolCallId: "valid", toolName: "read", input: {} }, 4),
      savedBlock("tool_result", { toolCallId: "valid", output: "first true result" }, 5),
      savedBlock("tool_result", { toolCallId: "valid", output: "duplicate result" }, 6),
      savedBlock("tool_use", { toolCallId: "unique", toolName: "read", input: {} }, 7),
      savedBlock("tool_result", { toolCallId: "unique", output: "unique true result" }, 8),
      savedBlock("text", "A later step", 9),
      savedBlock("tool_use", { toolCallId: "duplicate", toolName: "read", input: {} }, 10),
      savedBlock("tool_result", { toolCallId: "duplicate", output: "later true result" }, 11),
    ];
    const { messages } = history(blocks);
    assertCompleteToolGroups(messages);
    const parts = messages.flatMap((message) => message.content);
    expect(parts.filter((part) => part.type === "tool_use").map((part) => part.toolCallId)).toEqual(
      ["unique", "duplicate"],
    );
    expect(parts.filter((part) => part.type === "tool_result").map((part) => part.output)).toEqual([
      "unique true result",
      "later true result",
    ]);
    const wire = providerRequests(messages);
    expect(wire.chat.messages.filter((message) => message.role === "tool")).toHaveLength(2);
  });

  it("logs only identifiers and failed fields while live and cold projections stay immutable and deterministic", () => {
    const blocks = freezeHistory([
      savedBlock(
        "tool_use",
        {
          toolCallId: "private-call",
          toolName: "read",
          input: "PRIVATE_INVALID_INPUT",
          providerData: "PRIVATE_CALL_PROVIDER",
        },
        0,
      ),
      savedBlock(
        "tool_result",
        {
          toolCallId: "private-call",
          output: "model-visible output",
          result: "PRIVATE_TYPED_RESULT",
          metadata: { secret: "PRIVATE_METADATA" },
          providerData: { secret: "PRIVATE_PROVIDER_DATA" },
        },
        1,
      ),
      savedBlock("text", "Keep this answer.", 2),
    ]);
    const turns = freezeHistory([turn("assistant")]);
    const before = JSON.stringify({ blocks, turns });
    const eventSink = createInMemoryEventSink();
    const input = { thread: thread(), turns, blocks, systemPrompt: "Write stories.", eventSink };
    const first = buildContext(input);
    const second = buildContext(input);
    expect(second).toEqual(first);
    const cold = transcriptSegments({ turns, blocks }, 10_000, "anthropic");
    expect(transcriptSegments({ turns, blocks }, 10_000, "anthropic")).toEqual(cold);
    const diagnostics = turnContextMessages(turns[0], blocks)
      .flatMap((message) => message.content)
      .filter((part) => part.type === "text");
    for (const part of diagnostics) expect(cold.join("\n")).toContain(part.text);
    expect(JSON.stringify({ first, cold })).not.toMatch(
      /PRIVATE_TYPED_RESULT|PRIVATE_METADATA|PRIVATE_PROVIDER_DATA|PRIVATE_CALL_PROVIDER/,
    );
    expect(JSON.stringify(first.messages)).toContain("model-visible output");
    expect(cold.join("\n")).toContain("model-visible output");
    expect(eventSink.events.length).toBeGreaterThan(0);
    const logged = JSON.stringify(eventSink.events);
    expect(logged).toContain("input");
    expect(logged).toContain("saved-0");
    expect(logged).not.toMatch(/PRIVATE_|model-visible output|Keep this answer/);
    expect(JSON.stringify({ blocks, turns })).toBe(before);
  });

  it("repairs a missing result before merging same-turn diagnostics into a later tool call", () => {
    const blocks = [
      savedBlock("tool_use", { toolCallId: "missing-first", toolName: "read", input: {} }, 0),
      savedBlock("tool_result", null, 1),
      savedBlock("tool_use", { toolCallId: "next", toolName: "read", input: {} }, 2),
      savedBlock("tool_result", { toolCallId: "next", output: "next result" }, 3),
    ];
    const { messages } = history(blocks);
    assertCompleteToolGroups(messages);
    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
    const repaired = messages[2]?.content[0];
    expect(repaired).toMatchObject({
      type: "tool_result",
      toolCallId: "missing-first",
      isError: true,
    });
    expect(repaired && "output" in repaired && repaired.output).toContain(
      "Tool call did not finish",
    );
    expect(messages[3]?.content.map((part) => part.type)).toEqual(["text", "tool_use"]);
  });

  it("keeps separate valid assistant turns separate", () => {
    const turns = [
      { ...turn("assistant", "first"), position: 1 },
      { ...turn("assistant", "second"), position: 2 },
    ];
    const blocks = [
      savedBlock("text", "First answer.", 0, { turnId: "first" }),
      savedBlock("text", "Second answer.", 0, { id: "second-text", turnId: "second" }),
    ];
    expect(history(blocks, turns).messages.slice(1)).toMatchObject([
      { role: "assistant", content: [{ type: "text", text: "First answer." }] },
      { role: "assistant", content: [{ type: "text", text: "Second answer." }] },
    ]);
  });
});
