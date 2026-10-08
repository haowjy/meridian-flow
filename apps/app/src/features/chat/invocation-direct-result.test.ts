import type { Block, JsonValue } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { directResultsForTurn } from "./invocation-direct-result";
import { block } from "./report-test-fixtures";

function card(mode = "direct", execution: string | null = "execution-1") {
  return block("card", 0, "custom", {
    kind: "helper-result",
    props: {
      agentSlug: "critic",
      agentName: "Critic",
      parentTurnId: "parent-turn",
      toolCallId: "call-1",
      childThreadId: "child-1",
      deliveryMode: mode,
      execution,
      startedAt: "2026-01-01T00:00:00.000Z",
      terminalAt: "2026-01-01T00:01:00.000Z",
      outcome: "succeeded",
    },
  });
}

function toolResult(name: string, result: JsonValue, isError = false): [Block, Block] {
  return [
    block("use", 1, "tool_use", {
      toolCallId: "call-1",
      toolName: name,
      input: {},
      result: null,
      isError: false,
    }),
    block("result", 2, "tool_result", {
      toolCallId: "call-1",
      output: "Subagent p3\n\nReport (completed)",
      result,
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
  it("does not join another parent turn or tool call with the same execution", () => {
    const [use, result] = toolResult("spawn", success);
    expect(resultFor([{ ...use, turnId: "other" }, card(), result])).toBeNull();
    expect(resultFor([use, card(), { ...result, turnId: "other" }])).toBeNull();
    expect(
      resultFor([use, card(), { ...result, content: { toolCallId: "other", result: success } }]),
    ).toBeNull();
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
          content: { toolCallId: "call-1", result: { ...success, execution: "other" } },
        },
      ]),
    ).toBeNull();
    expect(resultFor([use, card("background_notification"), result])).toBeNull();
    expect(resultFor([use, card("direct", null), result])).toBeNull();
  });
});
