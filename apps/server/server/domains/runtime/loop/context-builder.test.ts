/** Consolidated test contracts; each block retains its original fixture scope. */

import {
  buildInvocationCardContent,
  type InvocationCardProps,
} from "@meridian/contracts/components";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import { describe as __mergedSuite, expect, it } from "vitest";
import type { Notice } from "../../notices/index.js";
import { invocationCardProps } from "../spawn/spawn-output.js";
import { localBlockFromEvent } from "./block-helpers.js";
import { buildContext } from "./context-builder.js";
import { planMessageTurns } from "./inbox-context.js";
import { writeModeSwitchNotice, writeModeSwitchTurn } from "./write-mode-switch.js";

__mergedSuite("context-builder.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/loop/context-builder.test.ts.
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

  __mergedSuite("buildContext system-turn history projection", () => {
    const correlation = {
      parentTurnId: "turn-0",
      toolCallId: "spawn-1",
      deliveryMode: "background_notification" as const,
    };
    const runningCard = (): Extract<
      InvocationCardProps,
      {
        terminalAt: null;
      }
    > =>
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
});

__mergedSuite("inbox-context.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/loop/inbox-context.test.ts.
  function reversal(id: number, direction: "undo" | "redo", handle = "w1"): Notice {
    return {
      id,
      kind: "undo",
      scope: { kind: "thread", threadId: "thread-1" },
      message: "",
      data: { uri: "manuscript://Scene", turnId: handle, direction },
      createdAt: new Date(id),
    };
  }

  function plan(notices: Notice[]) {
    return planMessageTurns({
      threadId: "thread-1" as ThreadId,
      batch: [],
      notices,
      prevTurnId: "previous-turn" as TurnId,
      prevTurnPosition: 1,
      knownTurnIds: new Set<TurnId>(),
    });
  }

  __mergedSuite("notice materialization", () => {
    it("does not append history when undo then redo cancel before delivery", () => {
      expect(plan([reversal(1, "undo"), reversal(2, "redo")])).toEqual({
        turns: [],
        blocks: [],
        events: [],
        leafTurnId: "previous-turn",
        noticesTurnId: null,
      });
    });
    it("does not append history for empty or whitespace-only notices", () => {
      const empty = { ...reversal(1, "undo"), kind: "other", message: " \n " };
      expect(plan([empty]).turns).toEqual([]);
    });
    it("still reports undo alone", () => {
      expect(plan([reversal(1, "undo")]).blocks[0]?.content).toContain(
        "The user reversed the following edits before this message:\n- Scene",
      );
    });
    it("reports restoration when the undo was delivered in an earlier batch", () => {
      expect(plan([reversal(2, "redo")]).blocks[0]?.content).toContain(
        "The user restored the following edits before this message:\n- Scene",
      );
    });
    it("keeps unrelated notices when reversals cancel", () => {
      const work = { ...reversal(3, "undo"), kind: "other", message: "The Work changed." };
      expect(plan([reversal(1, "undo"), reversal(2, "redo"), work]).blocks[0]?.content).toBe(
        "<system_update>\nThe Work changed.\n</system_update>",
      );
    });
    it("reports only the edits still undone", () => {
      expect(
        plan([reversal(1, "undo"), reversal(2, "redo"), reversal(3, "undo", "w2")]).blocks[0]
          ?.content,
      ).toContain("- Scene");
    });
  });
});
