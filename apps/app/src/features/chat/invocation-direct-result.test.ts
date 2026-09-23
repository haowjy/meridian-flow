import type { Block, JsonValue, Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { reconcileSnapshotTurns } from "@/client/stores/thread-store/reconcile-snapshot-turns";
import { directResultsForTurn } from "./invocation-direct-result";

function resultForCard(blocks: Block[], invocation: Block) {
  return (
    directResultsForTurn([...blocks.filter((block) => block.id !== invocation.id), invocation]).get(
      invocation.id,
    ) ?? null
  );
}

function block(
  id: string,
  sequence: number,
  blockType: Block["blockType"],
  content: JsonValue,
): Block {
  return {
    id,
    turnId: "parent-turn",
    responseId: null,
    blockType,
    sequence,
    content,
    status: "complete",
    textContent: null,
    createdAt: "2026-09-23T00:00:00.000Z",
  };
}

function card(mode = "direct", execution: string | null = "execution-1") {
  return block("card", 0, "custom", {
    kind: "helper-result",
    props: {
      parentTurnId: "parent-turn",
      toolCallId: "call-1",
      childThreadId: "child-1",
      deliveryMode: mode,
      execution,
      status: "completed",
      outcome: "succeeded",
    },
  });
}

function toolResult(name: string, output: JsonValue, isError = false): [Block, Block] {
  return [
    block("use", 1, "tool_use", {
      toolCallId: "call-1",
      toolName: name,
      input: {},
      output: null,
      isError: false,
    }),
    block("result", 2, "tool_result", {
      toolCallId: "call-1",
      output,
      isError,
      message: isError ? "Tool failed" : null,
    }),
  ];
}

const success: JsonValue = {
  status: "completed",
  execution: "execution-1",
  outcome: "succeeded",
  report: { threadId: "child-1", summary: "First line.\nFull report.", payload: { answer: 42 } },
};

describe("direct invocation result join", () => {
  it.each([
    "spawn",
    "thread_message",
  ])("joins persisted %s use/card/result order through authoritative replacement", (name) => {
    const [use, savedResult] = toolResult(name, success);
    const result = { ...savedResult, sequence: 3 };
    const invocation = { ...card(), sequence: 2 };
    const durable = [use, invocation, result];
    expect(directResultsForTurn([use, result]).size).toBe(0);
    expect(directResultsForTurn(durable).get(invocation.id)?.summary).toBe(
      "First line.\nFull report.",
    );
    expect(resultForCard([use, result], invocation)?.summary).toBe("First line.\nFull report.");
    expect(resultForCard(durable, invocation)?.summary).toBe("First line.\nFull report.");

    const turn = (blocks: Block[]): Turn => ({
      id: "parent-turn",
      threadId: "parent-thread",
      role: "assistant",
      writeMode: null,
      status: "complete",
      finishReason: "end_turn",
      inputTokens: 0,
      outputTokens: 0,
      totalCostUsd: "0",
      responseCount: 0,
      usage: null,
      error: null,
      createdAt: "2026-09-23T00:00:00.000Z",
      completedAt: "2026-09-23T00:00:00.000Z",
      blocks,
      siblingIds: [],
      responses: [],
    });
    const [settled] = reconcileSnapshotTurns([turn([use, result])], [turn(durable)]);
    expect(resultForCard(settled.blocks, invocation)?.summary).toBe("First line.\nFull report.");
  });

  it.each([
    [
      "empty",
      {
        status: "completed",
        execution: "execution-1",
        outcome: "succeeded",
        report: { summary: "" },
      },
      "succeeded",
      "",
    ],
    [
      "failure",
      {
        status: "error",
        execution: "execution-1",
        outcome: "failed",
        report: { summary: "Partial" },
        partial: true,
      },
      "failed",
      "Partial",
    ],
    [
      "cancel",
      {
        status: "error",
        execution: "execution-1",
        outcome: "cancelled",
        report: { summary: "" },
        partial: true,
      },
      "cancelled",
      "",
    ],
  ] as const)("preserves persisted %s settlement", (_label, output, outcome, summary) => {
    for (const name of ["spawn", "thread_message"]) {
      const [use, result] = toolResult(name, output, outcome !== "succeeded");
      expect(resultForCard([use, card(), { ...result, sequence: 3 }], card())).toMatchObject({
        outcome,
        summary,
      });
    }
  });

  it("keeps a correlated unavailable settlement distinct from a terminal outcome", () => {
    const fallback = {
      status: "error",
      execution: "execution-1",
      error: {
        code: "spawn_unavailable",
        message: "Child report is unavailable",
        source: "system",
        retryable: false,
      },
    };
    const [use, result] = toolResult("thread_message", fallback, true);
    expect(resultForCard([use, card(), { ...result, sequence: 3 }], card())).toMatchObject({
      execution: "execution-1",
      outcome: null,
      message: "Child report is unavailable",
    });
    expect(
      resultForCard([use, card(), { ...result, sequence: 3 }], card("background_notification")),
    ).toBeNull();
    expect(
      resultForCard([use, card(), { ...result, sequence: 3 }], card("direct", "other")),
    ).toBeNull();
  });

  it("does not join another parent turn or tool call with the same execution", () => {
    const [use, result] = toolResult("spawn", success);
    expect(resultForCard([{ ...use, turnId: "other" }, result], card())).toBeNull();
    expect(resultForCard([use, { ...result, turnId: "other" }], card())).toBeNull();
    expect(
      resultForCard(
        [use, { ...result, content: { toolCallId: "other", output: success } }],
        card(),
      ),
    ).toBeNull();
  });

  it("joins the live reducer's settled output on the named use", () => {
    const [use] = toolResult("spawn", success);
    const mergedUse = {
      ...use,
      content: { toolCallId: "call-1", toolName: "spawn", output: success },
    };
    expect(directResultsForTurn([mergedUse, card()]).get("card")?.summary).toBe(
      "First line.\nFull report.",
    );
  });
  it.each([
    "spawn",
    "thread_message",
  ])("joins settled %s results before or after card load", (name) => {
    const blocks = toolResult(name, success);
    expect(resultForCard(blocks, card())?.summary).toBe("First line.\nFull report.");
    expect(resultForCard([card(), ...blocks], card())?.payload).toEqual({ answer: 42 });
  });

  it("preserves an error envelope and available partial report", () => {
    const partial: JsonValue = {
      status: "error",
      execution: "execution-1",
      outcome: "failed",
      partial: true,
      reason: "budget_exhausted",
      report: { threadId: "child-1", summary: "Saved partial text." },
    };
    expect(resultForCard(toolResult("spawn", partial, true), card())).toMatchObject({
      outcome: "failed",
      summary: "Saved partial text.",
      partial: true,
      message: "budget_exhausted",
    });
  });

  it("does not show terminal card status or tool-call end before a result envelope settles", () => {
    const admissionAndToolEnd = [
      card(),
      block("use", 1, "tool_use", {
        toolCallId: "call-1",
        toolName: "spawn",
        input: {},
        output: null,
        isError: false,
      }),
    ];
    expect(resultForCard(admissionAndToolEnd, card())).toBeNull();
  });

  it("keeps empty success truthful and does not borrow another execution or mode", () => {
    const empty: JsonValue = {
      status: "completed",
      execution: "execution-1",
      outcome: "succeeded",
      report: { threadId: "child-1", summary: "" },
    };
    const direct = toolResult("thread_message", empty);
    expect(resultForCard(direct, card())).toMatchObject({
      summary: "",
      outcome: "succeeded",
    });
    expect(
      resultForCard(toolResult("spawn", { ...success, execution: "other" }, false), card()),
    ).toBeNull();
    expect(resultForCard(direct, card("background_notification"))).toBeNull();
    expect(resultForCard(direct, card("direct", null))).toBeNull();
  });
});
