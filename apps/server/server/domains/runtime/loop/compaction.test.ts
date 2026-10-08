/** Pure fixtures for compaction classification, triggering, planning, and projection. */

import type { ThreadId } from "@meridian/contracts/runtime";
import type { Block, JsonObject, Thread, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { compactionTurnMetadata } from "../../threads/index.js";
import {
  CJK_CODE_POINT_TOKEN_RATES,
  estimateRequestTokens,
  FLOW_ABSOLUTE_CEILING,
  planCompaction,
  projectActiveHistoryWithBakes,
  resolveCompactionTrigger,
} from "./compaction/index.js";
import { buildContext } from "./context-builder.js";
import { messageTurnFor } from "./inbox-context.js";
import type { InboxMessage } from "./ports.js";

const noPromptBakes = { findById: async () => null };

const THREAD_ID = "thread-1" as ThreadId;

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

function thread(ref: string | null = "c12"): Thread {
  return {
    id: THREAD_ID,
    projectId: "project-1",
    workId: null,
    userId: "user-1",
    kind: "primary",
    status: "idle",
    title: null,
    ref,
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
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

function inboxMessage(
  id: string,
  provenance: InboxMessage["provenance"],
  body: InboxMessage["body"] = { kind: "text", text: id },
): InboxMessage {
  return {
    id,
    threadId: THREAD_ID,
    seq: 1,
    intent: "message",
    provenance,
    body,
    idempotencyKey: `idem-${id}`,
    enqueuedAt: "2026-01-01T00:00:00.000Z",
    deliveredAt: null,
  };
}

function compactionTurn(
  id: string,
  position: number,
  cutTurnId: string,
  pinnedRequestTurnId: string,
  status: Turn["status"] = "complete",
  extra: Partial<Turn> = {},
): Turn {
  return turn(id, position, "compaction", {
    origin: "system",
    status,
    metadata: compactionTurnMetadata({
      compactedThrough: { turnId: cutTurnId },
      pinnedRequestTurnIds: [pinnedRequestTurnId],
    }),
    ...extra,
  });
}

function compactionBlock(
  id: string,
  turnId: string,
  summary = "The heroine exposed the forged record.",
): Block {
  return block(id, turnId, 0, "custom", {
    kind: "compaction",
    props: {
      summary,
      excludedTurnCount: 3,
      tokensBefore: 900,
      tokensAfter: 80,
      model: "fixture-model",
    },
  });
}

describe("resolveCompactionTrigger", () => {
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
  it("applies the CJK family rate to reasoning and nested tool input/output strings", () => {
    const text = "中".repeat(100);
    const estimated = estimateRequestTokens({
      request: {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "reasoning", text },
              {
                type: "tool_use",
                toolCallId: "call-1",
                toolName: "read",
                input: { chapter: text },
              },
              { type: "tool_result", toolCallId: "call-1", output: { chapter: text } },
            ],
          },
        ],
      },
      baseline: null,
      tokenizer: "deepseek",
    });
    expect(estimated).toBeGreaterThanOrEqual(3 * text.length * CJK_CODE_POINT_TOKEN_RATES.deepseek);
  });
});

describe("planCompaction", () => {
  const estimate = (_turn: Turn, blocks: readonly Block[]) =>
    blocks.reduce((sum, entry) => {
      const content = entry.content as { tokens?: number } | null;
      return sum + (content?.tokens ?? 0);
    }, 0);

  it("cuts inside an assistant turn after a complete tool group and pins the request", () => {
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
      fitLimitTokens: 100,
      tailBudgetBaseTokens: 100,
      fixedOverheadTokens: 0,
      tokenizer: "anthropic",
      estimateTurnTokens: estimate,
    });

    expect(plan.compactedThrough).toEqual({ turnId: assistantTurn.id, blockSequence: 2 });
    expect(plan.pinnedRequests.at(-1)?.id).toBe(request.id);
    expect(plan.retainedSuffix.map(({ blocks: kept }) => kept.map(({ id }) => id))).toEqual([
      [],
      ["tool-use-2", "tool-result-2", "new-text"],
    ]);
    expect(plan.minimalTailFits).toBe(true);
  });

  it("includes system prompt and tool-schema overhead in the minimal fit guarantee", () => {
    const request = turn("request", 1, "user");
    const answer = turn("answer", 2, "assistant");
    const blocks = [
      block("request-text", request.id, 0, "text", { tokens: 8 }, "ask"),
      block("answer-text", answer.id, 0, "text", { tokens: 5 }, "reply"),
    ];
    const plan = planCompaction({
      turns: [request, answer],
      blocks,
      fitLimitTokens: 30,
      tailBudgetBaseTokens: 30,
      fixedOverheadTokens: 20,
      tokenizer: "anthropic",
      estimateTurnTokens: estimate,
    });

    expect(plan.minimalTailTokens).toBeGreaterThanOrEqual(30);
    expect(plan.minimalTailFits).toBe(false);
  });

  it("does not let an old tool group make forty later chat exchanges too large", async () => {
    const turns: Turn[] = [];
    const blocks: Block[] = [];
    const oldRequest = messageTurnFor(
      inboxMessage("old-request", { kind: "writer", actorId: "user-1" }),
      null,
      1,
    ).turn;
    const oldAnswer = turn("old-answer", 2, "assistant");
    turns.push(oldRequest, oldAnswer);
    blocks.push(
      block("old-use", oldAnswer.id, 0, "tool_use", { toolCallId: "historical-tool", input: {} }),
      block("old-result", oldAnswer.id, 1, "tool_result", {
        toolCallId: "historical-tool",
        output: "finished",
      }),
      block("old-answer-text", oldAnswer.id, 2, "text", { text: "old answer" }, "old answer"),
    );
    let position = 3;
    for (let exchange = 1; exchange <= 40; exchange++) {
      const request = messageTurnFor(
        inboxMessage(
          `request-${exchange}`,
          { kind: "writer", actorId: "user-1" },
          {
            kind: "text",
            text: `Writer request ${exchange}: continue the chapter with a concise beat.`,
          },
        ),
        null,
        position++,
      ).turn;
      const answer = turn(`answer-${exchange}`, position++, "assistant");
      turns.push(request, answer);
      blocks.push(
        block(
          `request-block-${exchange}`,
          request.id,
          0,
          "text",
          { text: `request ${exchange}` },
          `request ${exchange}`,
        ),
        block(
          `answer-block-${exchange}`,
          answer.id,
          0,
          "text",
          { text: `answer ${exchange}` },
          `answer ${exchange}`,
        ),
      );
    }
    const plan = planCompaction({
      turns,
      blocks,
      fitLimitTokens: 20_000,
      tailBudgetBaseTokens: 20_000,
      fixedOverheadTokens: 500,
      tokenizer: "anthropic",
    });
    expect(plan.minimalTailFits).toBe(true);

    const compaction = compactionTurn(
      "old-tool-compaction",
      position,
      plan.compactedThrough?.turnId ?? oldAnswer.id,
      plan.pinnedRequests.at(-1)?.id ?? turns.at(-2)?.id ?? oldRequest.id,
    );
    const projected = await projectActiveHistoryWithBakes(
      [...turns, compaction],
      [...blocks, compactionBlock("summary", compaction.id)],
      "c20",
      noPromptBakes,
    );
    const context = buildContext({ thread: thread("c20"), ...projected });
    expect(context.messages.at(-1)?.role).toBe("assistant");
    expect(
      context.messages.every(
        (message, index, messages) =>
          !(message.role === "assistant" && messages[index - 1]?.role === "assistant"),
      ),
    ).toBe(true);
  });

  it("plans 2,000 default-estimated turns in under 1.5 seconds", () => {
    const turns: Turn[] = [];
    const blocks: Block[] = [];
    for (let index = 0; index < 2_000; index++) {
      const isRequest = index % 2 === 0;
      const item = turn(`turn-${index}`, index + 1, isRequest ? "user" : "assistant");
      turns.push(item);
      blocks.push(
        block(
          `block-${index}`,
          item.id,
          0,
          "text",
          { text: `content ${index}` },
          `content ${index}`,
        ),
      );
    }
    const startedAt = performance.now();
    const plan = planCompaction({
      turns,
      blocks,
      fitLimitTokens: 1_000_000,
      tailBudgetBaseTokens: 1_000_000,
      fixedOverheadTokens: 5_000,
      tokenizer: "anthropic",
    });
    expect(plan.pinnedRequests.at(-1)?.id).toBe("turn-1998");
    expect(performance.now() - startedAt).toBeLessThan(1_500);
  });

  it("plans a second compaction only after the active compaction cut", async () => {
    const firstRequest = turn("first-request", 1, "user");
    const firstAnswer = turn("first-answer", 2, "assistant");
    const secondRequest = turn("second-request", 3, "user");
    const secondAnswer = turn("second-answer", 4, "assistant");
    const firstCompaction = compactionTurn("first-compaction", 5, firstAnswer.id, secondRequest.id);
    const turns = [firstRequest, firstAnswer, secondRequest, secondAnswer, firstCompaction];
    const blocks = [
      block("first-request-text", firstRequest.id, 0, "text", { text: "first" }, "first"),
      block("first-answer-text", firstAnswer.id, 0, "text", { text: "answer" }, "answer"),
      block("second-request-text", secondRequest.id, 0, "text", { text: "second" }, "second"),
      block("second-answer-text", secondAnswer.id, 0, "text", { text: "reply" }, "reply"),
      compactionBlock("first-summary", firstCompaction.id),
    ];
    const plan = planCompaction({
      turns,
      blocks,
      fitLimitTokens: 10_000,
      tailBudgetBaseTokens: 10_000,
      fixedOverheadTokens: 100,
      tokenizer: "anthropic",
    });
    expect(plan.outcome).toBe("planned");
    if (plan.outcome !== "planned") return;
    expect(plan.compactedThrough.turnId).not.toBe(firstAnswer.id);
    expect(plan.retainedSuffix.map(({ turn: retained }) => retained.id)).not.toContain(
      firstRequest.id,
    );
    expect(plan.retainedSuffix.map(({ turn: retained }) => retained.id)).not.toContain(
      firstAnswer.id,
    );

    const secondCompaction = compactionTurn(
      "second-compaction",
      6,
      plan.compactedThrough.turnId,
      (plan.pinnedRequests.at(-1) as Turn).id,
    );
    await expect(
      projectActiveHistoryWithBakes(
        [...turns, secondCompaction],
        [...blocks, compactionBlock("second-summary", secondCompaction.id)],
        "c100",
        noPromptBakes,
      ),
    ).resolves.toHaveProperty("turns");
  });
});

describe("projectActiveHistoryWithBakes", () => {
  it("throws instead of hiding malformed completed compactions", async () => {
    const malformed = compactionTurn("broken", 3, "request", "request", "complete", {
      metadata: { malformed: true } as JsonObject,
    });
    await expect(
      projectActiveHistoryWithBakes(
        [malformed],
        [compactionBlock("bad-props", malformed.id)],
        "c12",
        noPromptBakes,
      ),
    ).rejects.toThrow();

    const validMetadata = compactionTurn("bad-block", 3, "request", "request");
    const badProps = block("bad-props", validMetadata.id, 0, "custom", {
      kind: "compaction",
      props: { summary: "missing fields" },
    });
    await expect(
      projectActiveHistoryWithBakes([validMetadata], [badProps], "c12", noPromptBakes),
    ).rejects.toThrow();
  });

  it("throws when a complete compaction's pinned request is missing", async () => {
    const request = turn("request", 1, "user");
    const answer = turn("answer", 2, "assistant");
    const compaction = compactionTurn("c", 3, request.id, "deleted-request");
    await expect(
      projectActiveHistoryWithBakes(
        [request, answer, compaction],
        [compactionBlock("summary", compaction.id)],
        "c12",
        noPromptBakes,
      ),
    ).rejects.toThrow(/missing pinned request deleted-request/);
  });
});

describe("compaction-owned elisions", () => {
  it("substitutes only the active complete C retained tail, never later blocks", async () => {
    const old = turn("old", 0, "user");
    const pin = turn("pin", 1, "user");
    const reply = turn("reply", 2, "assistant");
    const c = compactionTurn("c", 3, "old", "pin");
    const late = turn("late", 4, "assistant");
    const raw = { toolCallId: "call", toolName: "write", output: "STALE" };
    const replacement = { ...raw, output: "FROZEN STUB" };
    c.metadata = {
      ...(c.metadata as JsonObject),
      elisions: [
        {
          blockId: "read",
          treatment: "stale_read",
          uris: ["manuscript://chapter"],
          content: replacement,
        },
        { blockId: "late-read", treatment: "stale_read", uris: [], content: replacement },
      ],
    };
    const blocks = [
      block("read", "reply", 0, "tool_result", raw),
      block("late-read", "late", 0, "tool_result", raw),
      compactionBlock("summary", c.id, "Summary"),
    ];
    const projected = await projectActiveHistoryWithBakes(
      [old, pin, reply, c, late],
      blocks,
      "c1",
      noPromptBakes,
    );
    expect(projected.blocks.find((b) => b.id === "read")?.content).toEqual(replacement);
    expect(projected.blocks.find((b) => b.id === "late-read")?.content).toEqual(raw);
    for (const status of ["pending", "error", "cancelled"] as const) {
      expect(
        (
          await projectActiveHistoryWithBakes(
            [old, pin, reply, { ...c, status }, late],
            blocks,
            "c1",
            noPromptBakes,
          )
        ).blocks,
      ).toEqual(blocks);
    }
    const next = compactionTurn("next", 6, "old", "pin");
    expect(
      (
        await projectActiveHistoryWithBakes(
          [old, pin, reply, c, late, next],
          [...blocks, compactionBlock("next-summary", next.id, "Next summary")],
          "c1",
          noPromptBakes,
        )
      ).blocks.find((b) => b.id === "read")?.content,
    ).toEqual(raw);
  });
});
