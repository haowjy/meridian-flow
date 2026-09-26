import type { Block, JsonValue } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { directResultsForTurn } from "./invocation-direct-result";
import { block } from "./report-test-fixtures";

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

function resultFor(blocks: Block[], invocation = card()) {
  return directResultsForTurn(blocks).get(invocation.id) ?? null;
}

const success: JsonValue = {
  status: "completed",
  execution: "execution-1",
  outcome: "succeeded",
  report: { threadId: "child-1", summary: "First line.\nFull report.", payload: { answer: 42 } },
};

describe("direct invocation result join", () => {
  it.each(["spawn", "thread_message"])("joins persisted %s use/card/result order", (name) => {
    const [use, savedResult] = toolResult(name, success);
    const invocation = { ...card(), sequence: 2 };
    const result = { ...savedResult, sequence: 3 };
    expect(directResultsForTurn([use, savedResult])).toHaveProperty("size", 0);
    expect(directResultsForTurn([use, invocation, result]).get(invocation.id)).toMatchObject({
      summary: "First line.\nFull report.",
      payload: { answer: 42 },
    });
  });

  it("admits report artifacts through the shared complete shape guard", () => {
    const [use, savedResult] = toolResult("spawn", {
      status: "completed",
      execution: "execution-1",
      outcome: "succeeded",
      report: {
        artifacts: [
          { type: "image", url: "https://example.test/image.png", label: "Cover" },
          { type: "object", uri: "scratch://draft" },
          { type: "image", url: "https://example.test/bad.png", mimeType: 42 },
          { type: "liveView", url: "https://example.test/view", expiresAt: false },
        ],
      },
    });
    const invocation = card();
    const result = directResultsForTurn([use, invocation, savedResult]).get(invocation.id);
    expect(result?.artifacts).toEqual([
      { type: "image", url: "https://example.test/image.png", label: "Cover" },
      { type: "object", uri: "scratch://draft" },
    ]);
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
      expect(resultFor([use, card(), result])).toMatchObject({ outcome, summary });
    }
  });

  it("keeps correlated unavailable evidence distinct from terminal outcomes", () => {
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
    expect(resultFor([use, card(), result])).toMatchObject({
      execution: "execution-1",
      outcome: null,
      message: "Child report is unavailable",
    });
    expect(resultFor([use, card("background_notification"), result])).toBeNull();
    expect(resultFor([use, card("direct", "other"), result])).toBeNull();
  });

  it("does not join another parent turn or tool call with the same execution", () => {
    const [use, result] = toolResult("spawn", success);
    expect(resultFor([{ ...use, turnId: "other" }, card(), result])).toBeNull();
    expect(resultFor([use, card(), { ...result, turnId: "other" }])).toBeNull();
    expect(
      resultFor([use, card(), { ...result, content: { toolCallId: "other", output: success } }]),
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

  it("preserves an error envelope and available partial report", () => {
    const partial: JsonValue = {
      status: "error",
      execution: "execution-1",
      outcome: "failed",
      partial: true,
      reason: "budget_exhausted",
      report: { threadId: "child-1", summary: "Saved partial text." },
    };
    const [use, result] = toolResult("spawn", partial, true);
    expect(resultFor([use, card(), result])).toMatchObject({
      outcome: "failed",
      summary: "Saved partial text.",
      partial: true,
      message: null,
      reason: "budget_exhausted",
    });
  });

  it("does not show terminal card status or tool-call end before a result envelope settles", () => {
    const use = block("use", 1, "tool_use", {
      toolCallId: "call-1",
      toolName: "spawn",
      input: {},
      output: null,
      isError: false,
    });
    expect(resultFor([card(), use])).toBeNull();
  });

  it("keeps empty success truthful and does not borrow another execution or mode", () => {
    const empty: JsonValue = {
      status: "completed",
      execution: "execution-1",
      outcome: "succeeded",
      report: { threadId: "child-1", summary: "" },
    };
    const [use, result] = toolResult("thread_message", empty);
    expect(resultFor([use, card(), result])).toMatchObject({ summary: "", outcome: "succeeded" });
    expect(
      resultFor([
        use,
        card(),
        {
          ...result,
          content: { toolCallId: "call-1", output: { ...success, execution: "other" } },
        },
      ]),
    ).toBeNull();
    expect(resultFor([use, card("background_notification"), result])).toBeNull();
    expect(resultFor([use, card("direct", null), result])).toBeNull();
  });
});
