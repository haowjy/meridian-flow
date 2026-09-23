import type { Block, JsonValue } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { directResultForInvocation } from "./invocation-direct-result";

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

function toolResult(name: string, output: JsonValue, isError = false) {
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
  ])("joins settled %s results before or after card load", (name) => {
    const blocks = toolResult(name, success);
    expect(directResultForInvocation(blocks, card())?.summary).toBe("First line.\nFull report.");
    expect(directResultForInvocation([card(), ...blocks], card())?.payload).toEqual({ answer: 42 });
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
    expect(directResultForInvocation(toolResult("spawn", partial, true), card())).toMatchObject({
      outcome: "failed",
      summary: "Saved partial text.",
      partial: true,
      message: "budget_exhausted",
    });
  });

  it("keeps empty success truthful and does not borrow another execution or mode", () => {
    const empty: JsonValue = {
      status: "completed",
      execution: "execution-1",
      outcome: "succeeded",
      report: { threadId: "child-1", summary: "" },
    };
    const direct = toolResult("thread_message", empty);
    expect(directResultForInvocation(direct, card())).toMatchObject({
      summary: "",
      outcome: "succeeded",
    });
    expect(
      directResultForInvocation(
        toolResult("spawn", { ...success, execution: "other" }, false),
        card(),
      ),
    ).toBeNull();
    expect(directResultForInvocation(direct, card("background_notification"))).toBeNull();
    expect(directResultForInvocation(direct, card("direct", null))).toBeNull();
  });
});
