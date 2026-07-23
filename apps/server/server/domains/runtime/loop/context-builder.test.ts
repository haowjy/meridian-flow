/** Protocol-invariant coverage for the thread-history projection. */
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import type { Message, ToolResultPart } from "../gateway/index.js";
import { buildContext } from "./context-builder.js";

const createdAt = "2026-07-23T00:00:00.000Z";
const thread: Thread = {
  id: "thread-1",
  projectId: "project-1",
  workId: null,
  userId: "user-1",
  kind: "primary",
  status: "idle",
  title: null,
  composedSystemPrompt: "System prompt",
  bakedSkillSlugs: [],
  systemPrompt: null,
  workingState: null,
  currentAgent: null,
  activeLeafTurnId: null,
  parentThreadId: null,
  rootThreadId: "thread-1",
  spawnDepth: 0,
  spawnStatus: null,
  totalCostUsd: "0",
  turnCount: 0,
  createdAt,
  updatedAt: createdAt,
  deletedAt: null,
};

function assistantTurn(id: string, status: Turn["status"]): Turn {
  return {
    id,
    threadId: thread.id,
    role: "assistant",
    status,
    finishReason: "tool_use",
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: "0",
    responseCount: 1,
    usage: null,
    error: null,
    createdAt,
    completedAt: createdAt,
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}

function toolUse(turnId: string, sequence: number, toolCallId: string): Block {
  return {
    id: `use-${toolCallId}`,
    turnId,
    responseId: null,
    blockType: "tool_use",
    sequence,
    content: { toolCallId, toolName: "read", input: {} },
    createdAt,
  };
}

function toolResultBlock(turnId: string, sequence: number, toolCallId: string): Block {
  return {
    id: `result-${toolCallId}`,
    turnId,
    responseId: null,
    blockType: "tool_result",
    sequence,
    content: { toolCallId, output: "recorded result" },
    createdAt,
  };
}

function danglingToolUseIds(messages: readonly Message[]): string[] {
  return messages.flatMap((message, index) => {
    if (message.role !== "assistant") return [];
    const resultIds = new Set<string>();
    for (const following of messages.slice(index + 1)) {
      if (following.role !== "tool") break;
      for (const part of following.content) {
        if (part.type === "tool_result") resultIds.add(part.toolCallId);
      }
    }
    return message.content.flatMap((part) =>
      part.type === "tool_use" && !resultIds.has(part.toolCallId) ? [part.toolCallId] : [],
    );
  });
}

describe("buildContext tool-call history", () => {
  it("synthesizes status-aware error results for dangling calls", () => {
    const scenarios = [
      {
        turn: assistantTurn("single-turn", "cancelled"),
        blocks: [toolUse("single-turn", 0, "call-dangling")],
        danglingId: "call-dangling",
        provenance: /cancelled/i,
      },
      {
        turn: assistantTurn("multi-turn", "error"),
        blocks: [
          toolUse("multi-turn", 0, "call-1"),
          toolResultBlock("multi-turn", 1, "call-1"),
          toolUse("multi-turn", 2, "call-2"),
          toolResultBlock("multi-turn", 3, "call-2"),
          toolUse("multi-turn", 4, "call-3"),
        ],
        danglingId: "call-3",
        provenance: /error/i,
      },
    ];

    for (const scenario of scenarios) {
      const { messages } = buildContext({
        thread,
        turns: [scenario.turn],
        blocks: scenario.blocks,
      });

      expect(danglingToolUseIds(messages)).toEqual([]);
      const synthesizedResult = messages
        .flatMap((message) => message.content)
        .find(
          (part): part is ToolResultPart =>
            part.type === "tool_result" && part.toolCallId === scenario.danglingId,
        );
      expect(synthesizedResult?.isError).toBe(true);
      expect(synthesizedResult?.output).toEqual(expect.stringMatching(scenario.provenance));
    }
  });
});
