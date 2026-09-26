import type { Block, JsonValue, Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { assistantTurnCopy } from "./assistant-turn-copy";

function block(
  blockType: Block["blockType"],
  sequence: number,
  textContent?: string,
  content?: JsonValue,
): Block {
  return {
    id: `block-${sequence}`,
    turnId: "turn-1",
    responseId: null,
    blockType,
    sequence,
    content: content ?? null,
    status: "complete",
    textContent,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function turn(blocks: Block[]): Turn {
  return {
    id: "turn-1",
    threadId: "thread-1",
    role: "assistant",
    origin: "assistant",
    writeMode: null,
    status: "complete",
    finishReason: null,
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: "0",
    responseCount: 1,
    usage: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    blocks,
    siblingIds: [],
    responses: [],
  };
}

describe("assistantTurnCopy", () => {
  it("copies only final prose after tool activity as markdown and clean rich HTML", () => {
    const result = assistantTurnCopy(
      turn([
        block("text", 0, "Interim note that should not copy."),
        block("tool_use", 1, undefined, {
          toolCallId: "tool-1",
          toolName: "read",
          input: {},
        }),
        block("tool_result", 2, undefined, { toolCallId: "tool-1", output: "read" }),
        block(
          "text",
          3,
          "# Final answer\n\nA **bold** result with [[Chapter 1]].\n\n- First\n- Second\n\n[Source](https://example.com).",
        ),
      ]),
    );

    expect(result.markdown).toBe(
      "# Final answer\n\nA **bold** result with [[Chapter 1]].\n\n- First\n- Second\n\n[Source](https://example.com).",
    );
    expect(result.html).toContain("<h1>Final answer</h1>");
    expect(result.html).toContain("<strong>bold</strong>");
    expect(result.html).toContain("<ul>");
    expect(result.html).toContain('<a href="https://example.com/"');
    expect(result.html).toContain(">Source</a>");
    expect(result.html).toContain("Chapter 1");
    expect(result.html).not.toContain("class=");
    expect(result.html).not.toContain("Interim note");
  });

  it("includes a trailing report's summary and payload after the last fold", () => {
    const result = assistantTurnCopy(
      turn([
        block("reasoning", 0, "thinking"),
        block("tool_use", 1, undefined, {
          toolCallId: "report-1",
          toolName: "return_result",
          input: { summary: "## Report\n\nDone.", payload: { answer: 42 }, artifacts: [] },
        }),
      ]),
    );

    expect(result.markdown).toBe('## Report\n\nDone.\n\n{\n  "answer": 42\n}');
    expect(result.html).toContain("<h2>Report</h2>");
    expect(result.html).toContain("Done.");
  });

  it("copies all prose when the turn has no process fold", () => {
    expect(
      assistantTurnCopy(turn([block("text", 0, "First."), block("text", 1, "Second.")])).markdown,
    ).toBe("First.\n\nSecond.");
  });
});
