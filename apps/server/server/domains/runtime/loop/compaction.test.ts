/** Consolidated test contracts; each block retains its original fixture scope. */

import type { ThreadId } from "@meridian/contracts/runtime";
import type { Block, JsonObject, Thread, Turn } from "@meridian/contracts/threads";
import { describe as __mergedSuite, expect, it } from "vitest";
import { compactionTurnMetadata } from "../../threads/index.js";
import { createCoreToolRegistrations } from "../tools/core-tools.js";
import { collectRecordedDocuments, planModelElisions } from "./compaction/elide.js";
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

__mergedSuite("compaction.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/loop/compaction.test.ts.
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
      executionId: null,
      reservedForUserTurnIds: [],
      delivery: null,
      forgottenBy: null,
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
      aiWriteMode: "direct",
      effectiveAiWriteMode: "direct",
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

  __mergedSuite("resolveCompactionTrigger", () => {
    it("clamps at the usable window, the absolute ceiling, and zero", () => {
      expect(
        resolveCompactionTrigger({
          autocompact: 50000,
          contextWindow: 20000,
          maxOutputTokens: 10000,
        }).thresholdTokens,
      ).toBe(10000);
      expect(
        resolveCompactionTrigger({
          autocompact: 900000,
          contextWindow: 1000000,
          maxOutputTokens: 10000,
        }).thresholdTokens,
      ).toBe(FLOW_ABSOLUTE_CEILING);
      expect(
        resolveCompactionTrigger({
          autocompact_pct: 100,
          contextWindow: 4000,
          maxOutputTokens: 8000,
        }).thresholdTokens,
      ).toBe(0);
    });
  });

  __mergedSuite("estimateRequestTokens", () => {
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
      expect(estimated).toBeGreaterThanOrEqual(
        3 * text.length * CJK_CODE_POINT_TOKEN_RATES.deepseek,
      );
    });
  });

  __mergedSuite("planCompaction", () => {
    const estimate = (_turn: Turn, blocks: readonly Block[]) =>
      blocks.reduce((sum, entry) => {
        const content = entry.content as {
          tokens?: number;
        } | null;
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
      expect(plan.compactedThrough).toEqual({
        turnId: assistantTurn.id,
        blockSequence: 2,
      });
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
        block("old-use", oldAnswer.id, 0, "tool_use", {
          toolCallId: "historical-tool",
          input: {},
        }),
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
        fitLimitTokens: 20000,
        tailBudgetBaseTokens: 20000,
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
      for (let index = 0; index < 2000; index++) {
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
        fitLimitTokens: 1000000,
        tailBudgetBaseTokens: 1000000,
        fixedOverheadTokens: 5000,
        tokenizer: "anthropic",
      });
      expect(plan.pinnedRequests.at(-1)?.id).toBe("turn-1998");
      expect(performance.now() - startedAt).toBeLessThan(1500);
    });
    it("plans a second compaction only after the active compaction cut", async () => {
      const firstRequest = turn("first-request", 1, "user");
      const firstAnswer = turn("first-answer", 2, "assistant");
      const secondRequest = turn("second-request", 3, "user");
      const secondAnswer = turn("second-answer", 4, "assistant");
      const firstCompaction = compactionTurn(
        "first-compaction",
        5,
        firstAnswer.id,
        secondRequest.id,
      );
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
        fitLimitTokens: 10000,
        tailBudgetBaseTokens: 10000,
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

  __mergedSuite("projectActiveHistoryWithBakes", () => {
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
    it("projects a compaction whose pin and cut were handed back", async () => {
      // The compaction cut at, and pinned, a writer message that a hand-back took out of the chat.
      const earlier = turn("earlier", 1, "user");
      const answer = turn("answer", 2, "assistant");
      const compaction = compactionTurn("c", 4, "gone", "gone", "complete", { prevTurnId: "gone" });
      const after = turn("after", 5, "user");
      const projected = await projectActiveHistoryWithBakes(
        [earlier, answer, compaction, after],
        [compactionBlock("summary", compaction.id)],
        "c12",
        noPromptBakes,
      );
      expect(projected.turns.map((projectedTurn) => projectedTurn.id)).toEqual([
        "c:summary",
        "after",
      ]);
      // Risk (C4): a Retry-led compaction whose whole prefix was an attempt the chat later abandoned (every
      // turn it covered is forgotten) found no cut and made every later request throw. It keeps its summary.
      const alone = compactionTurn("c2", 4, "gone", "gone", "complete", { prevTurnId: "gone" });
      const emptied = await projectActiveHistoryWithBakes(
        [alone, turn("after2", 5, "user")],
        [compactionBlock("summary2", alone.id)],
        "c12",
        noPromptBakes,
      );
      expect(emptied.turns.map((projectedTurn) => projectedTurn.id)).toEqual([
        "c2:summary",
        "after2",
      ]);
    });
  });

  __mergedSuite("compaction-owned elisions", () => {
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
});

__mergedSuite("elide.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/loop/compaction/elide.test.ts.
  const registrations = createCoreToolRegistrations({
    read: async () => null,
    write: async () => null,
    work: async () => null,
    ls: async () => null,
    search: async () => null,
    ask_user: async () => null,
  });

  const policies = (name: string) =>
    registrations.find((r) => r.definition.name === name)?.documentText;

  function block(id: string, blockType: Block["blockType"], content: Block["content"]): Block {
    return {
      id,
      turnId: "turn",
      responseId: null,
      blockType,
      sequence: 0,
      content,
      status: "complete",
      createdAt: "2026-01-01",
    };
  }

  const evidence = {
    documentId: "00000000-0000-4000-8000-000000000001",
    uri: "manuscript://chapter.md",
    revision: "old",
  };

  const reasoning = block("reasoning", "reasoning", {
    text: "exact reasoning bytes",
    providerOptions: { signature: "signed" },
  });

  function plan(
    blocks: Block[],
    current = new Map([["00000000-0000-4000-8000-000000000001", "new"]]),
  ) {
    const before = JSON.stringify(blocks);
    const elisions = planModelElisions({
      retainedSuffix: [{ turn: { id: "turn" } as Turn, blocks }],
      recorded: collectRecordedDocuments([{ turn: { id: "turn" } as Turn, blocks }], policies),
      current,
      policies,
    });
    expect(JSON.stringify(blocks)).toBe(before);
    for (const elision of elisions) {
      const original = blocks.find((block) => block.id === elision.blockId);
      expect(original?.blockType).not.toBe("reasoning");
      if (original?.blockType === "tool_use" || original?.blockType === "tool_result") {
        const content = original.content as JsonObject;
        expect(elision.content).toMatchObject({
          toolCallId: content.toolCallId,
          toolName: content.toolName,
        });
      }
    }
    return elisions;
  }

  function pair(command: string, extra: JsonObject = {}, toolName = "write") {
    return [
      block("call", "tool_use", {
        toolCallId: "call-id",
        toolName,
        input: {
          command,
          path: evidence.uri,
          content: "OLD DOCUMENT",
          find: "OLD FIND",
          around: "OLD AROUND",
          in: "b41",
        },
      }),
      block("result", "tool_result", {
        toolCallId: "call-id",
        toolName,
        output: "OLD DOCUMENT",
        metadata: { documentRevisions: [evidence] },
        ...extra,
      }),
      reasoning,
    ];
  }

  __mergedSuite("document text elisions", () => {
    it("preserves fresh reads, duplicate reads and fresh writes", () => {
      for (const command of ["read", "create", "replace", "remove", "undo", "redo"])
        expect(
          plan(pair(command), new Map([["00000000-0000-4000-8000-000000000001", "old"]])),
        ).toEqual([]);
      const duplicate = pair("read").map((block) => ({
        ...block,
        id: `second-${block.id}`,
        content: { ...(block.content as JsonObject), toolCallId: "second-call" },
      }));
      expect(
        plan([...pair("read"), ...duplicate], new Map([[evidence.documentId, "old"]])),
      ).toEqual([]);
    });
    it("absent evidence fails closed but an explicit empty list carries no text", () => {
      expect(plan(pair("read", { metadata: {} }))).toHaveLength(1);
      expect(plan(pair("read", { metadata: { documentRevisions: [] } }))).toEqual([]);
    });
    it("search elides changed passages only, preserving files and match counts", () => {
      const blocks = pair(
        "search",
        {
          output: "b41|OLD DOCUMENT",
          result: [
            {
              uri: evidence.uri,
              matches: [{ excerpt: "OLD DOCUMENT", blockHash: "b41" }],
              matchCount: 4,
            },
            { uri: "kb://fresh", matches: [{ excerpt: "FRESH" }], matchCount: 1 },
          ],
          metadata: {
            documentRevisions: [
              evidence,
              { documentId: "fresh", uri: "kb://fresh", revision: "same" },
            ],
          },
        },
        "search",
      );
      const elisions = plan(
        blocks,
        new Map([
          ["00000000-0000-4000-8000-000000000001", "new"],
          ["fresh", "same"],
        ]),
      );
      expect(elisions).toHaveLength(1);
      expect(elisions[0]?.content).toMatchObject({
        toolCallId: "call-id",
        toolName: "search",
        // The typed hits re-render; only the changed file loses its passages (D65).
        output: [
          "manuscript://chapter.md (4 matches)",
          "[Cleared at compaction: changed since this search; read it for current text]",
          "",
          "kb://fresh",
          "FRESH",
        ].join("\n"),
      });
      // The model reads `output`; the typed `result` stays for the app.
      expect(String((elisions[0]?.content as JsonObject).output)).not.toContain("OLD DOCUMENT");
    });
    it("elides each pinned reference read without altering writer wording or mentions", () => {
      const reference = {
        type: "reference",
        documentId: "00000000-0000-4000-8000-000000000001",
        uri: evidence.uri,
        text: "Chapter",
        read: { result: "OLD DOCUMENT", revision: "y2:old" },
      };
      const blocks = [
        block("ref1", "text", reference),
        block("ref2", "text", reference),
        block("words", "text", "Writer words"),
        reasoning,
      ];
      const elisions = plan(blocks);
      expect(elisions).toHaveLength(2);
      expect(elisions[0]?.content).toMatchObject({
        type: "reference",
        documentId: "00000000-0000-4000-8000-000000000001",
        uri: evidence.uri,
        text: "Chapter",
        read: {
          revision: "y2:old",
        },
      });
      expect(JSON.stringify(elisions)).not.toContain("OLD DOCUMENT");
      const recorded = collectRecordedDocuments(
        [
          {
            turn: { id: "turn" } as Turn,
            blocks: [
              {
                ...blocks[0],
                content: elisions[0]?.content ?? null,
              },
            ],
          },
        ],
        policies,
      );
      expect(recorded.get("ref1")).toEqual([
        {
          documentId: reference.documentId,
          uri: reference.uri,
          revision: "y2:old",
        },
      ]);
    });
  });

  it("null recorded tokens remain unknown even when current is available", () => {
    expect(
      plan(pair("read", { metadata: { documentRevisions: [{ ...evidence, revision: null }] } })),
    ).toHaveLength(1);
  });

  it("freezes search content without borrowing unchanged nested output objects", () => {
    const blocks = pair(
      "search",
      {
        output: [
          { uri: evidence.uri, matches: [{ excerpt: "OLD DOCUMENT" }], matchCount: 1 },
          { uri: "kb://fresh", matches: [{ excerpt: "FRESH" }], matchCount: 1 },
        ],
      },
      "search",
    );
    const elisions = plan(blocks);
    ((blocks[1].content as JsonObject).output as JsonObject[])[1].matchCount = 999;
    expect(JSON.stringify(elisions)).not.toContain("999");
  });
});
