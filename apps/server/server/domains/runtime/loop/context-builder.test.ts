/**
 * System-role turns project a pre-admission invocation failure as model text;
 * terminal report cards stay as transcript-only writer UI.
 */
import {
  buildInvocationCardContent,
  type InvocationCardProps,
} from "@meridian/contracts/components";
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import { invocationCardProps, unadmittedInvocationFailureProps } from "../spawn/spawn-output.js";
import { buildContext } from "./context-builder.js";

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";

function thread(): Thread {
  return {
    id: THREAD_ID,
    projectId: "project-1",
    workId: null,
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

function systemMessageTexts(messages: ReturnType<typeof buildContext>["messages"]): string[] {
  return messages
    .filter((message) => message.role === "system")
    .flatMap((message) =>
      message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    );
}

function userMessageTexts(messages: ReturnType<typeof buildContext>["messages"]): string[] {
  return messages
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    );
}

describe("buildContext system-turn history projection", () => {
  it("assembles user history in turn-position order", () => {
    const newer = { ...turn("user", "newer"), position: 2 };
    const older = { ...turn("user", "older"), position: 1 };
    const { messages } = buildContext({
      thread: thread(),
      turns: [newer, older],
      blocks: [
        {
          id: "newer-block",
          turnId: "newer",
          responseId: null,
          blockType: "text",
          sequence: 0,
          content: { text: "second" },
          textContent: "second",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "older-block",
          turnId: "older",
          responseId: null,
          blockType: "text",
          sequence: 0,
          content: { text: "first" },
          textContent: "first",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      frozenSystemPrompt: "system prompt",
    });

    expect(userMessageTexts(messages)).toEqual(["first", "second"]);
  });

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

  it("projects a pre-admission failure reason as model context", () => {
    const content = buildInvocationCardContent(
      unadmittedInvocationFailureProps({
        agent: "critic",
        agentName: "Critic",
        correlation,
        reason: "The selected agent is unavailable.",
      }),
    );

    const { messages } = buildContext({
      thread: thread(),
      turns: [turn("system")],
      blocks: [customBlock(content)],
      frozenSystemPrompt: "system prompt",
    });

    expect(userMessageTexts(messages)).toContain(
      '<system_update>\nSubagent "Critic" could not start: The selected agent is unavailable.\n</system_update>',
    );
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
      frozenSystemPrompt: "system prompt",
    });

    expect(userMessageTexts(messages)).toEqual([]);
  });

  it("projects nothing while the card is still running", () => {
    const content = buildInvocationCardContent(runningCard());

    const { messages } = buildContext({
      thread: thread(),
      turns: [turn("system")],
      blocks: [customBlock(content)],
      frozenSystemPrompt: "system prompt",
    });

    expect(userMessageTexts(messages)).toEqual([]);
    expect(systemMessageTexts(messages)).toEqual(["system prompt"]);
  });

  it("projects nothing for an assistant-role custom block", () => {
    const content = buildInvocationCardContent(
      unadmittedInvocationFailureProps({
        agent: "critic",
        agentName: "Critic",
        correlation,
        reason: "Should stay UI-only.",
      }),
    );

    const { messages } = buildContext({
      thread: thread(),
      turns: [turn("assistant")],
      blocks: [customBlock(content)],
      frozenSystemPrompt: "system prompt",
    });

    expect(messages.some((message) => message.role === "assistant")).toBe(false);
    expect(systemMessageTexts(messages)).toEqual(["system prompt"]);
  });

  it("reports invalid persisted invocation and notification contracts", () => {
    const sink = createInMemoryEventSink();
    const invalidNotification = {
      ...turn("system", "notice-1"),
      metadata: { kind: "subagent_update", handle: "p1", outcome: "succeeded", execution: null },
    } as Turn;
    const invalidCard = customBlock({ kind: "helper-result", props: { status: "completed" } });

    buildContext({
      thread: thread(),
      turns: [invalidNotification],
      blocks: [invalidCard],
      eventSink: sink,
      frozenSystemPrompt: "system prompt",
    });

    expect(sink.events.map((event) => event.payload.field).sort()).toEqual([
      "invocation_card",
      "subagent_update",
    ]);
    expect(sink.events.every((event) => event.name === "chat.persisted_contract.invalid")).toBe(
      true,
    );
  });

  it("keeps adopted inbox parts after a tool result in one user message without changing the prompt", () => {
    const a = turn("assistant", "assistant-a");
    const update = turn("system", "system-update");
    const b = turn("user", "writer-1");
    const c = turn("user", "writer-2");
    const block = (
      id: string,
      turnId: string,
      blockType: Block["blockType"],
      textContent: string | null,
      content: Block["content"] = null,
      sequence = 0,
    ) => ({
      id,
      turnId,
      responseId: null,
      blockType,
      sequence,
      textContent,
      content,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const turns = [a, update, b, c];
    const blocks: Block[] = [
      block(
        "tool-use",
        a.id,
        "tool_use",
        null,
        { toolCallId: "call-1", toolName: "write", input: {} },
        0,
      ),
      block(
        "tool-result",
        a.id,
        "tool_result",
        null,
        { toolCallId: "call-1", output: { ok: true } },
        1,
      ),
      block(
        "update",
        update.id,
        "text",
        'Subagent p2 finished (succeeded). Read its report with thread_report({"ref":"p2"}).',
      ),
      block("writer-1", "writer-1", "text", "Writer message 1"),
      block("writer-2", "writer-2", "text", "Writer message 2"),
    ];
    const before = buildContext({
      thread: thread(),
      turns: [],
      blocks: [],
      frozenSystemPrompt: "system prompt",
    });
    const messages = buildContext({
      thread: thread(),
      turns,
      blocks,
      frozenSystemPrompt: "system prompt",
    }).messages;
    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "assistant",
      "tool",
      "user",
    ]);
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: `<system_update>\nSubagent p2 finished (succeeded). Read its report with thread_report({"ref":"p2"}).\n</system_update>`,
        },
        { type: "text", text: "Writer message 1" },
        { type: "text", text: "Writer message 2" },
      ],
    });
    expect(systemMessageTexts(messages)).toEqual(systemMessageTexts(before.messages));
  });
});

it("keeps document revision metadata out of model request bytes", () => {
  const documentId = "33333333-3333-4333-8333-333333333333";
  const uri = "manuscript://chapter.md";
  const user = turn("user", "user-turn");
  const assistant = { ...turn("assistant"), position: 2 };
  const reference = (revision: string | null): Block => ({
    ...customBlock({
      type: "reference",
      text: "@chapter",
      documentId,
      uri,
      read: { result: { body: "Current chapter." }, revision },
    }),
    turnId: user.id,
    blockType: "text",
  });
  const call: Block = {
    ...customBlock({ toolCallId: "read-1", name: "write", input: { command: "read", path: uri } }),
    id: "call",
    blockType: "tool_use",
  };
  const result = (revision?: string): Block => ({
    ...customBlock({
      toolCallId: "read-1",
      output: { body: "Current chapter." },
      ...(revision ? { metadata: { documentRevisions: [{ documentId, uri, revision }] } } : {}),
    }),
    id: "result",
    blockType: "tool_result",
    sequence: 1,
  });
  const bytes = (revision?: string) =>
    JSON.stringify(
      buildContext({
        thread: thread(),
        turns: [user, assistant],
        blocks: [reference(revision ?? null), call, result(revision)],
        frozenSystemPrompt: "Frozen system.",
      }).messages,
    );
  expect(bytes("y1:read-revision")).toBe(bytes());
  expect(bytes("y1:another-revision")).toBe(bytes());
  expect(bytes()).toContain("Current chapter.");
});
