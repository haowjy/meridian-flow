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
import { invocationCardProps } from "../spawn/spawn-output.js";
import { localBlockFromEvent } from "./block-helpers.js";
import { buildContext } from "./context-builder.js";
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
      data: { uri: "manuscript://Scene", writeHandles: ["e1"], direction },
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
