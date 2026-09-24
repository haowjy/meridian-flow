import type { Block } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import type { ToolView } from "./group-delivery-segments";
import { countFoldTools } from "./thinking-digest";

const keyBlock: Block = {
  id: "block-0",
  turnId: "turn-1",
  responseId: null,
  blockType: "tool_use",
  sequence: 0,
  content: null,
  status: "complete",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function tool(args: {
  toolName: string;
  input?: Record<string, unknown>;
  isError?: boolean;
}): ToolView {
  return {
    toolCallId: `call-${args.toolName}`,
    toolName: args.toolName,
    input: (args.input ?? null) as ToolView["input"],
    output: null,
    status: "complete",
    isError: args.isError ?? false,
    message: null,
    streamedOutput: null,
    metadata: null,
    keyBlock,
  };
}

describe("countFoldTools", () => {
  it("does not count a diff review as an edit", () => {
    const counts = countFoldTools([
      // A diff carries no `path` on the wire; the writer-facing classification
      // must hold regardless, including the document identity the old branch
      // consumed.
      tool({ toolName: "write", input: { command: "diff", document_id: "ch1.md" } }),
      tool({ toolName: "write", input: { command: "diff", path: "ch1.md" } }),
    ]);

    expect(counts.editedDocuments.size).toBe(0);
    expect(counts.readDocuments.size).toBe(0);
    expect(counts.steps).toBe(2);
  });

  it("counts non-document tools and failed operations as steps", () => {
    const counts = countFoldTools([
      tool({ toolName: "search" }),
      tool({ toolName: "ls" }),
      tool({ toolName: "work" }),
      tool({ toolName: "write", input: { command: "read", path: "ch1.md" }, isError: true }),
    ]);

    expect(counts.steps).toBe(4);
    expect(counts.readDocuments.size).toBe(0);
  });
});
