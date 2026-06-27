import type { Block, Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";

import { resolveWriteUri, turnWrittenDocuments } from "./TurnChangeFooter";

describe("resolveWriteUri", () => {
  it("keeps full URIs unchanged", () => {
    expect(resolveWriteUri("kb://world/rules.md")).toBe("kb://world/rules.md");
    expect(resolveWriteUri("manuscript://chapter-1.mdx")).toBe("manuscript://chapter-1.mdx");
  });

  it("treats bare paths as manuscript URIs", () => {
    expect(resolveWriteUri("chapter-1.mdx")).toBe("manuscript://chapter-1.mdx");
    expect(resolveWriteUri("/arc/chapter-2.mdx")).toBe("manuscript://arc/chapter-2.mdx");
  });
});

describe("turnWrittenDocuments", () => {
  it("extracts unique write and edit paths in first-seen order", () => {
    const turn = turnWithBlocks([
      toolUseBlock(1, "read", "notes.md"),
      toolUseBlock(2, "write", "/chapter-1.mdx"),
      toolUseBlock(3, "edit", "kb://world/rules.md"),
      toolUseBlock(4, "write", "/chapter-1.mdx"),
      textBlock(5),
    ]);

    expect(turnWrittenDocuments(turn)).toEqual([
      {
        path: "/chapter-1.mdx",
        uri: "manuscript://chapter-1.mdx",
        nav: { scheme: "manuscript", path: "/chapter-1.mdx" },
      },
      {
        path: "kb://world/rules.md",
        uri: "kb://world/rules.md",
        nav: { scheme: "kb", path: "/world/rules.md" },
      },
    ]);
  });

  it("ignores malformed tool inputs", () => {
    const turn = turnWithBlocks([
      {
        ...toolUseBlock(1, "write", "chapter-1.mdx"),
        content: { toolName: "write", input: { path: 42 } },
      },
      { ...toolUseBlock(2, "edit", "chapter-2.mdx"), content: { toolName: "edit" } },
    ]);

    expect(turnWrittenDocuments(turn)).toEqual([]);
  });
});

function turnWithBlocks(blocks: Block[]): Turn {
  return {
    id: "turn-1",
    threadId: "thread-1",
    role: "assistant",
    status: "complete",
    finishReason: "end_turn",
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: "0",
    usage: null,
    error: null,
    responseCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
    blocks,
    siblingIds: [],
    responses: [],
  };
}

function toolUseBlock(sequence: number, toolName: string, path: string): Block {
  return {
    id: `block-${sequence}`,
    turnId: "turn-1",
    responseId: null,
    blockType: "tool_use",
    sequence,
    content: { toolName, input: { path } },
    status: "complete",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function textBlock(sequence: number): Block {
  return {
    id: `block-${sequence}`,
    turnId: "turn-1",
    responseId: null,
    blockType: "text",
    sequence,
    textContent: "Done.",
    content: {},
    status: "complete",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
