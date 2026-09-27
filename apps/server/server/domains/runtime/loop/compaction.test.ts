import { MODEL_REGISTRY } from "../gateway/index.js";
/** Pure fixtures for compaction classification, triggering, planning, and projection. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, JsonObject, Thread, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import {
  agentRequestMetadata,
  childSeedMetadata,
  classifyHistoryItem,
  compactionTurnMetadata,
  compactionUndoMetadata,
  derivationSeedMetadata,
  encodeImageInclusionMetadata,
  foregroundMessageMetadata,
  savedSubagentReportMetadata,
  skillBodyMetadata,
  workUpdateMetadata,
  writerSendMetadata,
} from "../../threads/index.js";
import { SKILL_BODY_METADATA } from "./activated-skills.js";
import {
  CJK_CODE_POINT_TOKEN_MULTIPLIER,
  CompactionBlockContentCodec,
  CompactionPropsCodec,
  estimateRequestTokens,
  FILE_PART_TOKEN_ESTIMATE,
  FLOW_ABSOLUTE_CEILING,
  IMAGE_PART_TOKEN_ESTIMATE,
  planCompaction,
  projectActiveHistory,
  projectCompactedHistory,
  resolveCompactionTrigger,
} from "./compaction/index.js";
import { buildContext } from "./context-builder.js";
import { messageTurnFor, noticesTurnFor } from "./inbox-context.js";
import type { InboxMessage } from "./ports.js";

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
      pinnedRequestTurnId,
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

function signedReasoning(id: string, turnId: string, sequence: number, signature: string): Block {
  return block(
    id,
    turnId,
    sequence,
    "reasoning",
    { text: `thinking ${signature}`, providerOptions: { anthropic: { signature } } },
    `thinking ${signature}`,
  );
}

function requestMessage(text: string) {
  return { role: "user" as const, content: [{ type: "text" as const, text }] };
}

describe("classifyHistoryItem", () => {
  it("classifies turns produced by the real inbox and metadata constructors", () => {
    const writer = messageTurnFor(
      inboxMessage("writer", { kind: "writer", actorId: "user-1" }),
      null,
      1,
    ).turn;
    const writerWithMetadata = turn("writer-with-metadata", 16, "user", {
      origin: "writer",
      metadata: writerSendMetadata({ activatedSkillSlugs: ["scribe"] }),
    });
    const inbox = messageTurnFor(
      inboxMessage("inbox", { kind: "agent", threadId: "agent-thread" as ThreadId }),
      null,
      2,
    ).turn;
    const work = messageTurnFor(
      inboxMessage("work", { kind: "system", source: "work" }, { kind: "work_context_refresh" }),
      null,
      3,
    ).turn;
    const childCompletion = messageTurnFor(
      inboxMessage("child", {
        kind: "child",
        threadId: "child-thread" as ThreadId,
        reportId: "report-1" as TurnId,
        handle: "p4",
        outcome: "succeeded",
        agentName: "Mage",
      }),
      null,
      4,
    ).turn;
    const notice = noticesTurnFor(THREAD_ID, [], null, 5).turn;
    const skill = turn("skill", 6, "system", { metadata: skillBodyMetadata() });
    expect(SKILL_BODY_METADATA).toEqual(skillBodyMetadata());
    const image = turn("image", 7, "system", {
      metadata: encodeImageInclusionMetadata([]),
    });
    const childSeed = turn("seed", 8, "user", {
      origin: "system",
      metadata: childSeedMetadata(),
    });
    const foreground = turn("foreground", 9, "user", {
      origin: "system",
      metadata: foregroundMessageMetadata(),
    });
    const fork = turn("fork", 10, "system", { metadata: derivationSeedMetadata("fork") });
    const handoff = turn("handoff", 11, "system", { metadata: derivationSeedMetadata("handoff") });
    const undo = turn("undo", 12, "system", {
      metadata: compactionUndoMetadata("compaction"),
    });
    const compaction = compactionTurn("compaction", 13, "old", "request", "pending");
    const savedReport = turn("saved-report", 14, "system", {
      metadata: savedSubagentReportMetadata(),
    });
    const steer = turn("steer", 15, "user", {
      metadata: writerSendMetadata({ activatedSkillSlugs: ["scribe"] }, "steer"),
    });

    expect(classifyHistoryItem(writer)).toEqual({ kind: "writer_request" });
    expect(classifyHistoryItem(writerWithMetadata)).toEqual({ kind: "writer_request" });
    expect(classifyHistoryItem(inbox)).toEqual({ kind: "agent_request", source: "inbox_message" });
    expect(classifyHistoryItem(childSeed)).toEqual({ kind: "agent_request", source: "child_seed" });
    expect(classifyHistoryItem(foreground)).toEqual({
      kind: "agent_request",
      source: "foreground_message",
    });
    expect(classifyHistoryItem(childCompletion)).toEqual({ kind: "child_completion" });
    expect(classifyHistoryItem(work)).toEqual({ kind: "work_update" });
    expect(classifyHistoryItem(notice)).toEqual({ kind: "notice" });
    expect(classifyHistoryItem(skill)).toEqual({ kind: "skill_body" });
    expect(classifyHistoryItem(image)).toEqual({ kind: "image_update" });
    expect(classifyHistoryItem(savedReport)).toEqual({ kind: "system_update" });
    expect(classifyHistoryItem(steer)).toEqual({ kind: "writer_request", delivery: "steer" });
    expect(classifyHistoryItem(fork)).toEqual({ kind: "fork_or_handoff_seed", derivation: "fork" });
    expect(classifyHistoryItem(handoff)).toEqual({
      kind: "fork_or_handoff_seed",
      derivation: "handoff",
    });
    expect(classifyHistoryItem(compaction)).toEqual({
      kind: "compaction",
      metadata: {
        compactedThrough: { turnId: "old" },
        pinnedRequestTurnId: "request",
      },
    });
    expect(classifyHistoryItem(undo)).toEqual({
      kind: "undo_marker",
      compactionTurnId: "compaction",
    });
  });

  it("uses the driver's origin for spawn versus foreground continuation metadata", () => {
    expect(agentRequestMetadata("spawn")).toEqual(childSeedMetadata());
    expect(agentRequestMetadata("message")).toEqual(foregroundMessageMetadata());
  });
});

describe("resolveCompactionTrigger", () => {
  it("defaults every registered flat-priced model to its usable window or ceiling", () => {
    for (const provider of MODEL_REGISTRY.providers) {
      for (const model of provider.models) {
        expect(resolveCompactionTrigger(model)).toEqual({
          thresholdTokens: Math.min(
            Math.floor(0.9 * (model.contextWindow - model.maxOutputTokens)),
            FLOW_ABSOLUTE_CEILING,
          ),
          usableWindowTokens: model.contextWindow - model.maxOutputTokens,
          source: "config_default",
        });
      }
    }
  });

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

  it("defaults flat-priced models to their usable window", () => {
    expect(
      resolveCompactionTrigger({ contextWindow: 100_000, maxOutputTokens: 10_000 }),
    ).toMatchObject({
      thresholdTokens: 81_000,
      source: "config_default",
    });
  });

  it("defaults to the pricing tier, with usable-window and ceiling clamps", () => {
    for (const [inputTierTokens, contextWindow, expected] of [
      [60_000, 100_000, 54_000],
      [95_000, 100_000, 81_000],
      [800_000, 1_000_000, 400_000],
    ]) {
      expect(
        resolveCompactionTrigger({ inputTierTokens, contextWindow, maxOutputTokens: 10_000 })
          .thresholdTokens,
      ).toBe(expected);
    }
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
  it("estimates full input and a baseline plus only newly appended messages", () => {
    const first = requestMessage("The old request should be represented by the usage baseline.");
    const next = requestMessage("Now continue from the fresh message.");
    const request = { messages: [first, next], tools: [] };
    const delta = estimateRequestTokens({
      request: { messages: [next] },
      baseline: { inputTokens: 0, messageCount: 0 },
    });

    expect(estimateRequestTokens({ request, baseline: null })).toBeGreaterThan(0);
    expect(
      estimateRequestTokens({ request, baseline: { inputTokens: 400, messageCount: 1 } }),
    ).toBe(400 + delta);
    expect(
      estimateRequestTokens({ request, baseline: { inputTokens: 400, messageCount: 2 } }),
    ).toBe(400);
  });

  it("counts images by type and file text from the payload providers actually receive", () => {
    const image = (data: string) => ({
      role: "user" as const,
      content: [{ type: "image" as const, data, mediaType: "image/png" }],
    });
    const largeImage = estimateRequestTokens({
      request: { messages: [image("x".repeat(1_400_000))] },
      baseline: null,
    });
    const smallImage = estimateRequestTokens({
      request: { messages: [image("x")] },
      baseline: null,
    });
    expect(largeImage).toBe(smallImage);
    expect(largeImage).toBeGreaterThanOrEqual(IMAGE_PART_TOKEN_ESTIMATE);

    const file = (data: string) => ({
      role: "user" as const,
      content: [{ type: "file" as const, data, mediaType: "text/plain", filename: "chapter.txt" }],
    });
    const longFile = estimateRequestTokens({
      request: { messages: [file("中".repeat(20_000))] },
      baseline: null,
    });
    const shortFile = estimateRequestTokens({
      request: { messages: [file("中")] },
      baseline: null,
    });
    expect(shortFile).toBeGreaterThanOrEqual(FILE_PART_TOKEN_ESTIMATE);
    expect(longFile).toBeGreaterThan(shortFile);
  });

  it("uses a conservative CJK code-point multiplier", () => {
    const text = "中".repeat(100);
    const estimated = estimateRequestTokens({
      request: { messages: [requestMessage(text)] },
      baseline: null,
    });
    expect(estimated).toBeGreaterThanOrEqual(text.length * CJK_CODE_POINT_TOKEN_MULTIPLIER);
  });

  it("applies the CJK multiplier to reasoning and nested tool input/output strings", () => {
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
    });
    expect(estimated).toBeGreaterThanOrEqual(3 * text.length * CJK_CODE_POINT_TOKEN_MULTIPLIER);
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
      triggerTokens: 100,
      summaryReserveTokens: 10,
      fixedOverheadTokens: 0,
      estimateTurnTokens: estimate,
    });

    expect(plan.compactedThrough).toEqual({ turnId: assistantTurn.id, blockSequence: 2 });
    expect(plan.pinnedRequest?.id).toBe(request.id);
    expect(plan.retainedSuffix.map(({ blocks: kept }) => kept.map(({ id }) => id))).toEqual([
      [],
      ["tool-use-2", "tool-result-2", "new-text"],
    ]);
    expect(plan.minimalTailFits).toBe(true);
  });

  it("keeps Work refreshes as ordinary retained separators", () => {
    const request = turn("request", 1, "user");
    const firstAssistant = turn("assistant-before-work", 2, "assistant");
    const work = turn("work-update", 3, "system", { metadata: workUpdateMetadata() });
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
      fixedOverheadTokens: 0,
      tailBudgetFraction: 0.4,
      estimateTurnTokens: estimate,
    });

    expect(plan.retainedSuffix.map(({ turn: kept }) => kept.id)).toEqual([
      request.id,
      firstAssistant.id,
      work.id,
      secondAssistant.id,
    ]);
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
      triggerTokens: 30,
      summaryReserveTokens: 5,
      fixedOverheadTokens: 15,
      estimateTurnTokens: estimate,
    });

    expect(plan.minimalTailTokens).toBeGreaterThanOrEqual(30);
    expect(plan.minimalTailFits).toBe(false);
  });

  it("does not let an old tool group make forty later chat exchanges too large", () => {
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
      triggerTokens: 20_000,
      summaryReserveTokens: 2_000,
      fixedOverheadTokens: 500,
    });
    expect(plan.minimalTailFits).toBe(true);

    const compaction = compactionTurn(
      "old-tool-compaction",
      position,
      plan.compactedThrough?.turnId ?? oldAnswer.id,
      plan.pinnedRequest?.id ?? turns.at(-2)?.id ?? oldRequest.id,
    );
    const projected = projectActiveHistory(
      [...turns, compaction],
      [...blocks, compactionBlock("summary", compaction.id)],
      "c20",
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
      triggerTokens: 1_000_000,
      summaryReserveTokens: 1_000,
      fixedOverheadTokens: 5_000,
    });
    expect(plan.pinnedRequest?.id).toBe("turn-1998");
    expect(performance.now() - startedAt).toBeLessThan(1_500);
  });

  it.each([
    { name: "Chinese-heavy turns", characters: 260, images: 0, toolGroups: false },
    { name: "several images", characters: 80, images: 4, toolGroups: false },
    {
      name: "tool groups with Chinese input and results",
      characters: 100,
      images: 0,
      toolGroups: true,
    },
  ])("keeps projected request estimates within the trigger for $name", ({
    characters,
    images,
    toolGroups,
  }) => {
    const turns: Turn[] = [];
    const blocks: Block[] = [];
    const chinese = "中".repeat(characters);
    for (let exchange = 0; exchange < 32; exchange++) {
      const request = turn(`request-${exchange}`, exchange * 2 + 1, "user");
      const answer = turn(`answer-${exchange}`, exchange * 2 + 2, "assistant");
      turns.push(request, answer);
      blocks.push(
        block(`request-text-${exchange}`, request.id, 0, "text", { text: chinese }, chinese),
      );
      if (toolGroups) {
        blocks.push(
          signedReasoning(`reasoning-${exchange}`, answer.id, 0, chinese),
          block(`tool-use-${exchange}`, answer.id, 1, "tool_use", {
            toolCallId: `call-${exchange}`,
            toolName: "read_chapter",
            input: { chapter: chinese },
          }),
          block(`tool-result-${exchange}`, answer.id, 2, "tool_result", {
            toolCallId: `call-${exchange}`,
            output: { chapter: chinese },
          }),
          block(`answer-text-${exchange}`, answer.id, 3, "text", { text: chinese }, chinese),
        );
      } else {
        blocks.push(
          block(`answer-text-${exchange}`, answer.id, 0, "text", { text: chinese }, chinese),
        );
      }
      if (exchange === 31) {
        for (let imageIndex = 0; imageIndex < images; imageIndex++) {
          blocks.push(
            block(`image-${imageIndex}`, request.id, imageIndex + 1, "image", {
              data: "x".repeat(10_000),
              mediaType: "image/png",
            }),
          );
        }
      }
    }

    const triggerTokens = 80_000;
    const fixedOverheadTokens = 2_000;
    const summaryReserveTokens = 1_500;
    const plan = planCompaction({
      turns,
      blocks,
      triggerTokens,
      summaryReserveTokens,
      fixedOverheadTokens,
    });
    expect(plan.minimalTailFits).toBe(true);
    expect(plan.outcome).toBe("planned");
    if (plan.outcome !== "planned") return;

    const compaction = compactionTurn(
      "planned-compaction",
      turns.length + 1,
      plan.compactedThrough.turnId,
      plan.pinnedRequest.id,
    );
    const projected = projectActiveHistory(
      [...turns, compaction],
      [...blocks, compactionBlock("planned-summary", compaction.id)],
      "c99",
    );
    const modelMessages = buildContext({ thread: thread("c99"), ...projected }).messages.filter(
      (message) => message.role !== "system",
    );
    const projectedEstimate = estimateRequestTokens({
      request: { messages: modelMessages, tools: [] },
      baseline: null,
    });
    expect(projectedEstimate + fixedOverheadTokens + summaryReserveTokens).toBeLessThanOrEqual(
      triggerTokens,
    );
  });

  it("returns no compaction rather than a persistable plan when there is no pinned request", () => {
    const onlyAssistant = turn("assistant", 1, "assistant");
    const plan = planCompaction({
      turns: [onlyAssistant],
      blocks: [],
      triggerTokens: 100,
      summaryReserveTokens: 10,
      fixedOverheadTokens: 10,
    });
    expect(plan).toMatchObject({
      outcome: "no_compaction",
      pinnedRequest: null,
      compactedThrough: null,
      minimalTailFits: false,
    });
  });

  it("plans a second compaction only after the active compaction cut", () => {
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
      triggerTokens: 10_000,
      summaryReserveTokens: 100,
      fixedOverheadTokens: 100,
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
      plan.pinnedRequest.id,
    );
    expect(() =>
      projectActiveHistory(
        [...turns, secondCompaction],
        [...blocks, compactionBlock("second-summary", secondCompaction.id)],
        "c100",
      ),
    ).not.toThrow();
  });
});

describe("projectActiveHistory", () => {
  it("projects 2,000 compaction-free turns by identity without decoding their metadata", () => {
    const turns = Array.from({ length: 2_000 }, (_, index) =>
      turn(`identity-${index}`, index + 1, index % 2 === 0 ? "user" : "assistant", {
        metadata: { unrelated: { deeply: { nested: "metadata" } } },
      }),
    );
    const blocks = turns.map((entry, index) =>
      block(`identity-block-${index}`, entry.id, 0, "text", { text: "content" }, "content"),
    );
    const startedAt = performance.now();
    const projected = projectActiveHistory(turns, blocks, "c12");
    expect(performance.now() - startedAt).toBeLessThan(50);
    expect(projected.turns).toEqual(turns);
    expect(projected.blocks).toEqual(blocks);
  });

  it("keeps a pinned request in place when it already follows the cut", () => {
    const r1 = turn("r1", 1, "user");
    const a1 = turn("a1", 2, "assistant");
    const r2 = messageTurnFor(
      inboxMessage(
        "r2",
        { kind: "writer", actorId: "user-1" },
        { kind: "text", text: "second request" },
      ),
      null,
      3,
    ).turn;
    const a2 = turn("a2", 4, "assistant");
    const compaction = compactionTurn("c", 5, r1.id, r2.id);
    const turns = [r1, a1, r2, a2, compaction];
    const blocks = [
      block("r1-text", r1.id, 0, "text", { text: "first request" }, "first request"),
      signedReasoning("a1-thinking", a1.id, 0, "sig-a1"),
      block("a1-text", a1.id, 1, "text", { text: "first reply" }, "first reply"),
      block("r2-text", r2.id, 0, "text", { text: "second request" }, "second request"),
      signedReasoning("a2-thinking-before", a2.id, 0, "sig-a2-before"),
      block("a2-tool-use", a2.id, 1, "tool_use", {
        toolCallId: "a2-tool",
        toolName: "thread_history",
        input: {},
      }),
      block("a2-tool-result", a2.id, 2, "tool_result", { toolCallId: "a2-tool", output: "detail" }),
      signedReasoning("a2-thinking-after", a2.id, 3, "sig-a2-after"),
      block("a2-text", a2.id, 4, "text", { text: "second reply" }, "second reply"),
      compactionBlock("c-summary", compaction.id),
    ];
    const projected = projectActiveHistory(turns, blocks, "p4");
    expect(projected.turns.map(({ id }) => id)).toEqual(["c:summary", "a1", "r2", "a2"]);
    expect(projected.blocks.map(({ turnId }) => turnId)).toEqual([
      "c:summary",
      "a1",
      "a1",
      "r2",
      "a2",
      "a2",
      "a2",
      "a2",
      "a2",
    ]);

    const context = buildContext({ thread: thread("p4"), ...projected });
    const roles = context.messages.map(({ role }) => role);
    expect(roles).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(
      roles.some((role, index) => role === "assistant" && roles[index - 1] === "assistant"),
    ).toBe(false);
    const summaryAndPin = context.messages[1]?.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    expect(summaryAndPin).toContain("(p4)");
    expect(
      context.messages.some((message) =>
        message.content.some(
          (part) => part.type === "text" && part.text.includes("second request"),
        ),
      ),
    ).toBe(true);
    const assistantReasoning = context.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content.filter((part) => part.type === "reasoning"));
    expect(assistantReasoning.map((part) => part.providerOptions)).toEqual([
      { anthropic: { signature: "sig-a1" } },
      { anthropic: { signature: "sig-a2-before" } },
      { anthropic: { signature: "sig-a2-after" } },
    ]);
    expect(
      context.messages
        .flatMap((message) => message.content)
        .filter((part) => part.type === "tool_use"),
    ).toHaveLength(1);
    expect(
      context.messages
        .flatMap((message) => message.content)
        .filter((part) => part.type === "tool_result"),
    ).toHaveLength(1);
  });

  it("cuts inside an assistant turn only after a whole tool group and keeps signed reasoning intact", () => {
    const oldRequest = turn("old-request", 1, "user");
    const oldAnswer = turn("old-answer", 2, "assistant");
    const pinned = turn("pinned", 3, "user");
    const current = turn("current", 4, "assistant");
    const compaction = compactionTurn("c", 5, current.id, pinned.id, "complete", {
      metadata: {
        compactedThrough: { turnId: current.id, blockSequence: 2 },
        pinnedRequestTurnId: pinned.id,
      },
    });
    const turns = [oldRequest, oldAnswer, pinned, current, compaction];
    const blocks = [
      block("old-request-text", oldRequest.id, 0, "text", { text: "old" }, "old"),
      block("old-answer-text", oldAnswer.id, 0, "text", { text: "old response" }, "old response"),
      block("pinned-text", pinned.id, 0, "text", { text: "pinned request" }, "pinned request"),
      signedReasoning("before-group", current.id, 0, "sig-before-cut"),
      block("use-1", current.id, 1, "tool_use", {
        toolCallId: "call-1",
        toolName: "search",
        input: {},
      }),
      block("result-1", current.id, 2, "tool_result", {
        toolCallId: "call-1",
        output: "old result",
      }),
      signedReasoning("after-first-group", current.id, 3, "sig-after-cut"),
      block("use-2", current.id, 4, "tool_use", {
        toolCallId: "call-2",
        toolName: "thread_history",
        input: {},
      }),
      block("result-2", current.id, 5, "tool_result", {
        toolCallId: "call-2",
        output: "kept result",
      }),
      signedReasoning("last-thinking", current.id, 6, "sig-last"),
      block("current-text", current.id, 7, "text", { text: "current answer" }, "current answer"),
      compactionBlock("c-summary", compaction.id),
    ];
    const projected = projectActiveHistory(turns, blocks, "c12");
    expect(projected.turns.map(({ id }) => id)).toEqual(["c:summary", pinned.id, current.id]);
    const context = buildContext({ thread: thread(), ...projected });
    const messages = context.messages;
    expect(messages.map(({ role }) => role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    const content = messages.flatMap((message) => message.content);
    expect(
      content.filter((part) => part.type === "tool_use").map((part) => part.toolCallId),
    ).toEqual(["call-2"]);
    expect(
      content.filter((part) => part.type === "tool_result").map((part) => part.toolCallId),
    ).toEqual(["call-2"]);
    expect(
      content.filter((part) => part.type === "reasoning").map((part) => part.providerOptions),
    ).toEqual([
      { anthropic: { signature: "sig-after-cut" } },
      { anthropic: { signature: "sig-last" } },
    ]);
  });

  it.each([
    "pending",
    "error",
    "cancelled",
  ] as const)("treats a %s compaction as identity", (status) => {
    const first = turn("request", 1, "user");
    const answer = turn("answer", 2, "assistant");
    const candidate = compactionTurn("c", 3, first.id, first.id, status);
    const turns = [first, answer, candidate];
    const blocks = [
      block("request-text", first.id, 0, "text", "request"),
      compactionBlock("c-summary", candidate.id),
    ];
    const baseline = buildContext({ thread: thread(), turns, blocks });
    const projected = projectActiveHistory(turns, blocks, "c12");
    expect(buildContext({ thread: thread(), ...projected }).messages).toEqual(baseline.messages);
  });

  it("treats reverted and inherited fork compactions correctly", () => {
    const oldRequest = turn("old-request", 1, "user");
    const request = turn("request", 2, "user");
    const answer = turn("answer", 3, "assistant");
    const compaction = compactionTurn("c", 4, oldRequest.id, request.id);
    const undo = turn("undo", 5, "system", { metadata: compactionUndoMetadata(compaction.id) });
    const turns = [oldRequest, request, answer, compaction, undo];
    const blocks = [
      block("old-request-text", oldRequest.id, 0, "text", "old request"),
      block("request-text", request.id, 0, "text", "request"),
      block("answer-text", answer.id, 0, "text", "answer"),
      compactionBlock("c-summary", compaction.id),
    ];
    const baseline = buildContext({ thread: thread(), turns, blocks });
    const revertedProjection = projectActiveHistory(turns, blocks, "c12");
    expect(buildContext({ thread: thread(), ...revertedProjection }).messages).toEqual(
      baseline.messages,
    );

    const forkLocal = turn("fork-local", 5, "user", { threadId: "fork-thread", origin: "writer" });
    const inherited = projectActiveHistory(
      [...turns.slice(0, 3), compaction, forkLocal],
      [...blocks, block("fork-text", forkLocal.id, 0, "text", "continue")],
      "c13",
    );
    expect(inherited.turns.map(({ id }) => id)).toContain("c:summary");
    expect(inherited.turns.map(({ id }) => id)).not.toContain(oldRequest.id);
    expect(inherited.turns.map(({ id }) => id)).toContain("fork-local");
  });

  it("throws instead of hiding malformed completed compactions", () => {
    const malformed = compactionTurn("broken", 3, "request", "request", "complete", {
      metadata: { malformed: true } as JsonObject,
    });
    expect(() =>
      projectActiveHistory([malformed], [compactionBlock("bad-props", malformed.id)], "c12"),
    ).toThrow();

    const validMetadata = compactionTurn("bad-block", 3, "request", "request");
    const badProps = block("bad-props", validMetadata.id, 0, "custom", {
      kind: "compaction",
      props: { summary: "missing fields" },
    });
    expect(() => projectActiveHistory([validMetadata], [badProps], "c12")).toThrow();
  });

  it("throws when a complete compaction's pinned request is missing", () => {
    const request = turn("request", 1, "user");
    const answer = turn("answer", 2, "assistant");
    const compaction = compactionTurn("c", 3, request.id, "deleted-request");
    expect(() =>
      projectActiveHistory(
        [request, answer, compaction],
        [compactionBlock("summary", compaction.id)],
        "c12",
      ),
    ).toThrow(/missing pinned request deleted-request/);
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

it("summarizes only the cut blocks plus the prior summary, not the lifted pin or tail", () => {
  const prior = turn("prior", 0, "user", {
    metadata: { kind: "system_update", section: "compaction_summary" },
  });
  const pin = turn("pin", 1, "user");
  const assistant = turn("reply", 2, "assistant");
  const tail = turn("tail", 3, "assistant");
  const blocks = [
    block("prior-text", prior.id, 0, "text", "Earlier facts", "Earlier facts"),
    block("pin-text", pin.id, 0, "text", "Latest request", "Latest request"),
    block("cut", assistant.id, 0, "text", "Done", "Done"),
    block("retained", assistant.id, 1, "text", "Recent", "Recent"),
    block("tail-text", tail.id, 0, "text", "Tail", "Tail"),
  ];
  const plan = {
    outcome: "planned" as const,
    pinnedRequest: pin,
    compactedThrough: { turnId: assistant.id, blockSequence: 0 },
    retainedSuffix: [
      { turn: pin, blocks: [blocks[1]] },
      { turn: assistant, blocks: [blocks[3]] },
      { turn: tail, blocks: [blocks[4]] },
    ],
    minimalTailFits: true,
    tailBudgetTokens: 100,
    minimalTailTokens: 100,
    retainedSuffixTokens: 100,
  };
  const projected = projectCompactedHistory({ turns: [prior, pin, assistant, tail], blocks }, plan);
  expect(projected.turns.map((turn) => turn.id)).toEqual(["prior", "reply"]);
  expect(projected.blocks.map((block) => block.id)).toEqual(["prior-text", "cut"]);
});
