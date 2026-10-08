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
