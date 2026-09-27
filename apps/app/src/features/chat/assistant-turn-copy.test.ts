import type { Block, JsonValue } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { assistantTurnCopyHtml, assistantTurnCopyMarkdown } from "./assistant-turn-copy";
import { partitionTurn } from "./partition-turn";

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

describe("assistant turn copy", () => {
  it("selects only final prose after a tool loop and renders rich HTML", () => {
    const items = partitionTurn([
      block("text", 0, "Interim note that should not copy."),
      block("tool_use", 1, undefined, { toolCallId: "tool-1", toolName: "read", input: {} }),
      block("tool_result", 2, undefined, { toolCallId: "tool-1", output: "read" }),
      block(
        "text",
        3,
        "# Final answer\n\nA **bold** result with [[Chapter 1]].\n\n- First\n- Second\n\n[Source](https://example.com).",
      ),
    ]);
    const markdown = assistantTurnCopyMarkdown(items);
    const html = assistantTurnCopyHtml(markdown);

    expect(markdown).toBe(
      "# Final answer\n\nA **bold** result with [[Chapter 1]].\n\n- First\n- Second\n\n[Source](https://example.com).",
    );
    expect(html).toContain("<h1>Final answer</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain('<a href="https://example.com/"');
    expect(html).toContain(">Source</a>");
    expect(html).toContain("Chapter 1");
    expect(html).not.toContain("class=");
    expect(html).not.toContain("Interim note");
  });

  it("copies final-answer images with the prose, never tool output", () => {
    const items = partitionTurn([
      block("tool_use", 0, undefined, { toolCallId: "tool-1", toolName: "read", input: {} }),
      block("tool_result", 1, undefined, { toolCallId: "tool-1", output: "tool text" }),
      block("text", 2, "Here is the map."),
      block("image", 3, undefined, {
        url: "https://example.com/map.png",
        alt: "Harbor map",
        caption: "The harbor at dusk",
      }),
    ]);
    const markdown = assistantTurnCopyMarkdown(items);

    expect(markdown).toBe(
      "Here is the map.\n\n![Harbor map](<https://example.com/map.png>)\n\nThe harbor at dusk",
    );
    expect(assistantTurnCopyHtml(markdown)).toContain('<img src="https://example.com/map.png"');
    expect(markdown).not.toContain("tool text");
  });

  it("fences report payloads in copied Markdown", () => {
    const markdown = assistantTurnCopyMarkdown(
      partitionTurn([
        block("reasoning", 0, "thinking"),
        block("tool_use", 1, undefined, {
          toolCallId: "report-1",
          toolName: "return_result",
          input: { summary: "## Report\n\nDone.", payload: { answer: 42 }, artifacts: [] },
        }),
      ]),
    );

    expect(markdown).toBe('## Report\n\nDone.\n\n```json\n{\n  "answer": 42\n}\n```');
    const html = assistantTurnCopyHtml(markdown);
    expect(html).toContain("<h2>Report</h2>");
    expect(html).toContain("Done.");
    expect(html).toContain("<pre><code>");
    expect(html).toContain('"answer": 42');
  });

  it("preserves attribute-like text inside code while stripping app attributes", () => {
    const html = assistantTurnCopyHtml('`<div class="x">`');
    expect(html).toContain('class="x"');
  });

  it("copies all prose when the turn has no process fold", () => {
    expect(
      assistantTurnCopyMarkdown(
        partitionTurn([block("text", 0, "First."), block("text", 1, "Second.")]),
      ),
    ).toBe("First.\n\nSecond.");
  });
});
