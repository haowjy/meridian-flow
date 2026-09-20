/**
 * System-role turns project a completed `helper-result` custom card as model
 * text; running cards and assistant-role custom blocks project nothing.
 */
import { buildHelperResultComponentContent } from "@meridian/contracts/components";
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
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
    composedSystemPrompt: "system prompt",
    bakedSkillSlugs: [],
    workingState: null,
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
    deletedAt: null,
  };
}

function turn(role: Turn["role"]): Turn {
  return {
    id: TURN_ID,
    threadId: THREAD_ID,
    prevTurnId: null,
    parentTurnId: null,
    role,
    writeMode: null,
    status: "complete",
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

describe("buildContext system-turn helper-result projection", () => {
  it("projects a completed helper-result card as system text", () => {
    const content = buildHelperResultComponentContent({
      agentSlug: "critic",
      agentName: "Critic",
      status: "completed",
      summary: "Two chapter breaks sag.",
      parentTurnId: "turn-0",
      payload: { chapter: 3 },
    });

    const { messages } = buildContext({
      thread: thread(),
      turns: [turn("system")],
      blocks: [customBlock(content)],
    });

    expect(systemMessageTexts(messages)).toContain(
      ['Background subagent "Critic" reported.', "Two chapter breaks sag.", '{"chapter":3}'].join(
        "\n",
      ),
    );
  });

  it("names a failed report as failed", () => {
    const content = buildHelperResultComponentContent({
      agentSlug: "critic",
      agentName: "Critic",
      status: "failed",
      summary: "Provider returned 500.",
      parentTurnId: "turn-0",
    });

    const { messages } = buildContext({
      thread: thread(),
      turns: [turn("system")],
      blocks: [customBlock(content)],
    });

    expect(systemMessageTexts(messages)).toContain(
      ['Background subagent "Critic" failed.', "Provider returned 500."].join("\n"),
    );
  });

  it("projects nothing while the card is still running", () => {
    const content = buildHelperResultComponentContent({
      agentSlug: "critic",
      agentName: "Critic",
      status: "running",
      parentTurnId: "turn-0",
    });

    const { messages } = buildContext({
      thread: thread(),
      turns: [turn("system")],
      blocks: [customBlock(content)],
    });

    expect(systemMessageTexts(messages)).toEqual(["system prompt"]);
  });

  it("projects nothing for an assistant-role custom block", () => {
    const content = buildHelperResultComponentContent({
      agentSlug: "critic",
      agentName: "Critic",
      status: "completed",
      summary: "Should stay UI-only.",
      parentTurnId: "turn-0",
    });

    const { messages } = buildContext({
      thread: thread(),
      turns: [turn("assistant")],
      blocks: [customBlock(content)],
    });

    expect(messages.some((message) => message.role === "assistant")).toBe(false);
    expect(systemMessageTexts(messages)).toEqual(["system prompt"]);
  });
});
