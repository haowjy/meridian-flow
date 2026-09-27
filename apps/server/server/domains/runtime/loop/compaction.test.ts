/** Pure fixtures for compaction classification, triggering, planning, and projection. */

import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import {
  CompactionBlockContentCodec,
  CompactionPropsCodec,
  classifyHistoryItem,
  estimateRequestTokens,
  FLOW_ABSOLUTE_CEILING,
  planCompaction,
  projectActiveHistory,
  resolveCompactionTrigger,
} from "./compaction.js";
import { buildContext } from "./context-builder.js";

const THREAD_ID = "thread-1";

function turn(id: string, position: number, role: Turn["role"], extra: Partial<Turn> = {}): Turn {
  return {
    id,
    threadId: THREAD_ID,
    position,
    prevTurnId: null,
    parentTurnId: null,
    role,
    origin: role === "user" ? "writer" : role === "assistant" ? "assistant" : "system",
    writeMode: null,
    status: "complete",
    promptBakeId: null,
    finishReason: role === "assistant" ? "end_turn" : null,
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
    ...extra,
  };
}

function block(
  id: string,
  turnId: string,
  sequence: number,
  blockType: Block["blockType"],
  content: Block["content"],
  textContent?: string,
): Block {
  return {
    id,
    turnId,
    responseId: null,
    blockType,
    sequence,
    content,
    textContent,
    status: "complete",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function compactionTurn(
  id: string,
  position: number,
  status: Turn["status"] = "complete",
  extra: Partial<Turn> = {},
): Turn {
  return turn(id, position, "compaction", {
    origin: "system",
    status,
    metadata: {
      compactedThrough: { turnId: "old-answer" },
      pinnedRequestTurnId: "pinned-request",
    },
    ...extra,
  });
}

function compactionBlock(id: string, turnId: string): Block {
  return block(id, turnId, 0, "custom", {
    kind: "compaction",
    props: {
      summary: "The heroine learned the regent forged the succession record.",
      excludedTurnCount: 3,
      tokensBefore: 900,
      tokensAfter: 80,
      model: "fixture-model",
    },
  });
}

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
    initialPromptBakeId: null,
    agentDefinitionRevisionId: null,
    agentName: null,
    nextSeq: "0",
    activeLeafTurnId: null,
    parentThreadId: null,
    originType: null,
    originTurnId: null,
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

describe("classifyHistoryItem", () => {
  it.each([
    ["writer request", turn("writer", 1, "user"), { kind: "writer_request" }],
    [
      "inbox agent request",
      turn("inbox", 1, "user", { origin: "system", metadata: { kind: "inbox_message" } }),
      { kind: "agent_request", source: "inbox_message" },
    ],
    [
      "child seed",
      turn("seed", 1, "user", {
        origin: "system",
        metadata: { agentRequestKind: "child_seed" },
      }),
      { kind: "agent_request", source: "child_seed" },
    ],
    [
      "foreground agent message",
      turn("foreground", 1, "user", { origin: "system" }),
      { kind: "agent_request", source: "foreground_message" },
    ],
    [
      "foreground agent message with unrelated metadata",
      turn("foreground-meta", 1, "user", { origin: "system", metadata: {} }),
      { kind: "agent_request", source: "foreground_message" },
    ],
    [
      "child completion",
      turn("child-completion", 1, "system", {
        metadata: { kind: "subagent_update", handle: "p1", outcome: "success", execution: "e1" },
      }),
      { kind: "child_completion" },
    ],
    [
      "Work update",
      turn("work", 1, "user", {
        origin: "system",
        metadata: { kind: "system_update", section: "work_context" },
      }),
      { kind: "work_update" },
    ],
    [
      "notice",
      turn("notice", 1, "system", {
        metadata: { kind: "system_update", section: "notices" },
      }),
      { kind: "notice" },
    ],
    [
      "skill body",
      turn("skill", 1, "system", {
        metadata: { kind: "system_update", section: "skill_body" },
      }),
      { kind: "skill_body" },
    ],
    [
      "image update by section",
      turn("image", 1, "system", { metadata: { section: "image_inclusion", breaks: [] } }),
      { kind: "image_update" },
    ],
    [
      "fork seed",
      turn("fork-seed", 1, "system", {
        metadata: { kind: "derivation_seed", derivation: "fork" },
      }),
      { kind: "fork_or_handoff_seed", derivation: "fork" },
    ],
    [
      "handoff seed",
      turn("handoff-seed", 1, "system", {
        metadata: { kind: "derivation_seed", derivation: "handoff" },
      }),
      { kind: "fork_or_handoff_seed", derivation: "handoff" },
    ],
    ["compaction", compactionTurn("compaction", 1, "pending"), { kind: "compaction" }],
    [
      "undo marker",
      turn("undo", 1, "system", {
        metadata: { kind: "compaction_undo", revertsCompactionTurnId: "compaction" },
      }),
      { kind: "undo_marker", compactionTurnId: "compaction" },
    ],
  ])("classifies %s", (_label, candidate, expected) => {
    expect(classifyHistoryItem(candidate)).toEqual(expected);
  });
});

describe("resolveCompactionTrigger", () => {
  it("normalizes explicit token and percent triggers to the usable window", () => {
    expect(
      resolveCompactionTrigger({
        autocompact: 80_000,
        contextWindow: 100_000,
        maxOutputTokens: 10_000,
        responseReserveTokens: 5_000,
        concurrentRenderSafetyTokens: 5_000,
      }),
    ).toEqual({ thresholdTokens: 80_000, usableWindowTokens: 80_000, source: "agent_tokens" });
    expect(
      resolveCompactionTrigger({
        autocompact_pct: 50,
        contextWindow: 100_000,
        maxOutputTokens: 10_000,
        responseReserveTokens: 5_000,
        concurrentRenderSafetyTokens: 5_000,
      }),
    ).toEqual({ thresholdTokens: 40_000, usableWindowTokens: 80_000, source: "agent_percent" });
  });

  it("keeps the config default off until C4d", () => {
    expect(
      resolveCompactionTrigger({ contextWindow: 100_000, maxOutputTokens: 10_000 }),
    ).toMatchObject({ thresholdTokens: null, source: "off" });
  });

  it("clamps at the usable window, the absolute ceiling, and zero", () => {
    expect(
      resolveCompactionTrigger({
        autocompact: 50_000,
        contextWindow: 20_000,
        maxOutputTokens: 10_000,
      }).thresholdTokens,
    ).toBe(10_000);
    expect(
      resolveCompactionTrigger({
        autocompact: 900_000,
        contextWindow: 1_000_000,
        maxOutputTokens: 10_000,
      }).thresholdTokens,
    ).toBe(FLOW_ABSOLUTE_CEILING);
    expect(
      resolveCompactionTrigger({
        autocompact_pct: 100,
        contextWindow: 4_000,
        maxOutputTokens: 8_000,
      }).thresholdTokens,
    ).toBe(0);
  });
});

describe("estimateRequestTokens", () => {
  const request = {
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "A fairly long request." }],
      },
    ],
    tools: [],
  };

  it("estimates the full request without a baseline and a nonnegative delta with one", () => {
    const whole = estimateRequestTokens({ request, baseline: null });
    expect(whole).toBeGreaterThan(0);
    expect(estimateRequestTokens({ request, baseline: { inputTokens: 1 } })).toBe(whole - 1);
    expect(estimateRequestTokens({ request, baseline: { inputTokens: whole + 1 } })).toBe(0);
  });
});

describe("planCompaction", () => {
  const estimate = (_turn: Turn, blocks: readonly Block[]) =>
    blocks.reduce((sum, entry) => {
      const content = entry.content as { tokens?: number } | null;
      return sum + (content?.tokens ?? 0);
    }, 0);

  it("cuts inside an assistant turn after a complete tool group and pins the request before the suffix", () => {
    const request = turn("request", 1, "user", { blocks: [] });
    const assistantTurn = turn("assistant", 2, "assistant");
    const blocks = [
      block("old-text", assistantTurn.id, 0, "text", { tokens: 50 }, "earlier prose"),
      block("tool-use-1", assistantTurn.id, 1, "tool_use", { toolCallId: "call-1", tokens: 2 }),
      block("tool-result-1", assistantTurn.id, 2, "tool_result", {
        toolCallId: "call-1",
        tokens: 3,
      }),
      block("tool-use-2", assistantTurn.id, 3, "tool_use", { toolCallId: "call-2", tokens: 2 }),
      block("tool-result-2", assistantTurn.id, 4, "tool_result", {
        toolCallId: "call-2",
        tokens: 3,
      }),
      block("new-text", assistantTurn.id, 5, "text", { tokens: 5 }, "the latest continuation"),
    ];
    const plan = planCompaction({
      turns: [request, assistantTurn],
      blocks,
      triggerTokens: 100,
      summaryReserveTokens: 10,
      estimateTurnTokens: estimate,
    });

    expect(plan.compactedThrough).toEqual({ turnId: assistantTurn.id, blockSequence: 2 });
    expect(plan.pinnedRequest?.id).toBe(request.id);
    expect(plan.retainedSuffix.map(({ blocks: kept }) => kept.map(({ id }) => id))).toEqual([
      ["tool-use-2", "tool-result-2", "new-text"],
    ]);
    expect(plan.minimalTailFits).toBe(true);
  });

  it("keeps the Work refresh inside a retained assistant suffix", () => {
    const request = turn("request", 1, "user");
    const firstAssistant = turn("assistant-before-work", 2, "assistant");
    const work = turn("work-update", 3, "system", {
      metadata: { kind: "system_update", section: "work_context" },
    });
    const secondAssistant = turn("assistant-after-work", 4, "assistant");
    const turns = [request, firstAssistant, work, secondAssistant];
    const blocks = turns.map((candidate, index) =>
      block(`b-${index}`, candidate.id, 0, "text", { tokens: 10 }, candidate.id),
    );
    const plan = planCompaction({
      turns,
      blocks,
      triggerTokens: 100,
      summaryReserveTokens: 5,
      tailBudgetFraction: 0.4,
      estimateTurnTokens: estimate,
    });

    expect(plan.retainedSuffix.map(({ turn: kept }) => kept.id)).toEqual([
      firstAssistant.id,
      work.id,
      secondAssistant.id,
    ]);
    expect(plan.keptWorkRefreshSeparators).toEqual([work]);
  });

  it("reports when the summary reserve, pinned request, and minimum tail cannot fit", () => {
    const request = turn("request", 1, "user");
    const assistantTurn = turn("assistant", 2, "assistant");
    const blocks = [
      block("prompt", request.id, 0, "text", { tokens: 8 }, "large ask"),
      block("tool-use", assistantTurn.id, 0, "tool_use", { toolCallId: "call", tokens: 2 }),
      block("tool-result", assistantTurn.id, 1, "tool_result", { toolCallId: "call", tokens: 5 }),
    ];
    const plan = planCompaction({
      turns: [request, assistantTurn],
      blocks,
      triggerTokens: 20,
      summaryReserveTokens: 10,
      estimateTurnTokens: estimate,
    });

    expect(plan.minimalTailTokens).toBeGreaterThanOrEqual(20);
    expect(plan.minimalTailFits).toBe(false);
  });
});

describe("projectActiveHistory", () => {
  const writer = turn("pinned-request", 3, "user", {
    blocks: [],
    metadata: { kind: "inbox_message" },
  });
  const work = turn("work-refresh", 3, "user", {
    origin: "system",
    metadata: { kind: "system_update", section: "work_context" },
  });
  const assistant = turn("current-answer", 5, "assistant");
  const originalTurns = [
    turn("old-request", 1, "user"),
    turn("old-answer", 2, "assistant"),
    work,
    { ...writer, position: 4 },
    assistant,
    compactionTurn("compaction", 6),
  ];
  const originalBlocks = [
    block("old-request-text", "old-request", 0, "text", "Do something old."),
    block("old-answer-text", "old-answer", 0, "text", "Old response."),
    block(
      "pinned-text",
      writer.id,
      0,
      "text",
      "Keep this exact request.",
      "Keep this exact request.",
    ),
    block(
      "work-text",
      work.id,
      0,
      "text",
      "Refresh the Work context.",
      "Refresh the Work context.",
    ),
    block("reasoning", assistant.id, 0, "reasoning", { text: "thinking" }),
    block(
      "assistant-text",
      assistant.id,
      1,
      "text",
      { text: "Draft the reveal." },
      "Draft the reveal.",
    ),
    compactionBlock("summary-block", "compaction"),
  ];

  it("projects a leading summary, pinned request, and extended-thinking assistant suffix", () => {
    const projected = projectActiveHistory(originalTurns, originalBlocks);
    const built = buildContext({ thread: thread(), ...projected });

    expect(projected.turns.map(({ id }) => id)).toEqual([
      "compaction:summary",
      "pinned-request",
      "work-refresh",
      "current-answer",
    ]);
    expect(built.messages.map(({ role }) => role)).toEqual(["system", "user", "assistant"]);
    const historyUserText = built.messages[1]?.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    expect(historyUserText).toContain("<system_update>");
    expect(historyUserText).toContain("(c1)");
    expect(historyUserText).toContain("Keep this exact request.");
    expect(historyUserText).toContain("Refresh the Work context.");
    expect(built.messages[2]?.content.map(({ type }) => type)).toEqual(["reasoning", "text"]);
  });

  it.each([
    "pending",
    "error",
    "cancelled",
  ] as const)("treats a %s compaction as identity", (status) => {
    const candidate = compactionTurn("compaction", 5, status);
    const turns = [...originalTurns.slice(0, -1), candidate];
    const baseline = buildContext({ thread: thread(), turns, blocks: originalBlocks });
    const projected = projectActiveHistory(turns, originalBlocks);
    expect(buildContext({ thread: thread(), ...projected }).messages).toEqual(baseline.messages);
  });

  it("treats a reverted compaction as identity and inherits a source compaction in a fork", () => {
    const undo = turn("undo", 7, "system", {
      metadata: { kind: "compaction_undo", revertsCompactionTurnId: "compaction" },
    });
    const revertedTurns = [...originalTurns, undo];
    const revertedBlocks = [
      ...originalBlocks,
      block("undo-text", undo.id, 0, "text", "Compaction undone."),
    ];
    const baseline = buildContext({
      thread: thread(),
      turns: revertedTurns,
      blocks: revertedBlocks,
    });
    const revertedProjection = projectActiveHistory(revertedTurns, revertedBlocks);
    expect(buildContext({ thread: thread(), ...revertedProjection }).messages).toEqual(
      baseline.messages,
    );

    const forkLocal = turn("fork-local", 7, "user", { threadId: "fork-thread", origin: "writer" });
    const inherited = projectActiveHistory(
      [...originalTurns, forkLocal],
      [...originalBlocks, block("fork-text", forkLocal.id, 0, "text", "Continue here.")],
    );
    expect(inherited.turns.map(({ id }) => id)).toContain("compaction:summary");
    expect(inherited.turns.map(({ id }) => id)).not.toContain("old-request");
    expect(inherited.turns.map(({ id }) => id)).toContain("fork-local");
  });

  it("decodes only well-shaped compaction props and block envelopes", () => {
    const validProps = {
      summary: "Summary",
      excludedTurnCount: 1,
      tokensBefore: 20,
      tokensAfter: 5,
      model: "fixture-model",
    };
    expect(CompactionPropsCodec.safeParse(validProps).success).toBe(true);
    expect(
      CompactionBlockContentCodec.safeParse({ kind: "compaction", props: validProps }).success,
    ).toBe(true);
    expect(
      CompactionBlockContentCodec.safeParse({ kind: "compaction", props: { summary: "missing" } })
        .success,
    ).toBe(false);
  });
});
