import type { Block } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import type { ToolView } from "./group-delivery-segments";
import { countFoldTools, thinkingDigest } from "./thinking-digest";

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
    result: null,
    status: "complete",
    isError: args.isError ?? false,
    message: null,
    streamedOutput: null,
    metadata: null,
    keyBlock,
  };
}

describe("countFoldTools", () => {
  it("counts read calls as reads and write calls as edits, by document", () => {
    const counts = countFoldTools([
      tool({ toolName: "read", input: { path: "ch1.md" } }),
      tool({ toolName: "read", input: { path: "ch1.md", format: "outline" } }),
      tool({ toolName: "read", input: { path: "ch2.md#scene" } }),
      tool({ toolName: "write", input: { command: "replace", path: "ch1.md" } }),
      tool({ toolName: "write", input: { command: "remove", path: "ch3.md" } }),
      tool({ toolName: "write", input: { command: "undo", path: "ch3.md" } }),
    ]);

    expect(counts.readDocuments.size).toBe(2);
    expect(counts.editedDocuments.size).toBe(2);
    expect(counts.steps).toBe(0);
  });

  it("counts a copy, whole or by blocks, as an edit of its destination", () => {
    const counts = countFoldTools([
      tool({
        toolName: "write",
        input: { command: "copy", path: "ch2.md", from: { path: "ch1.md" } },
      }),
      tool({
        toolName: "write",
        input: { command: "insert", path: "ch3.md", from: { path: "ch1.md" } },
      }),
    ]);

    expect([...counts.editedDocuments].sort()).toEqual([
      "manuscript://ch2.md",
      "manuscript://ch3.md",
    ]);
    expect(counts.steps).toBe(0);
  });

  it("counts non-document tools and failed operations as steps", () => {
    const counts = countFoldTools([
      tool({ toolName: "search" }),
      tool({ toolName: "ls" }),
      tool({ toolName: "work" }),
      tool({ toolName: "read", input: { path: "ch1.md" }, isError: true }),
    ]);

    expect(counts.steps).toBe(4);
    expect(counts.readDocuments.size).toBe(0);
  });

  it("counts a loaded skill by name and a skill file read as a step", () => {
    const counts = countFoldTools([
      tool({ toolName: "skill", input: { name: "story-review" } }),
      tool({ toolName: "skill", input: { name: "story-review" } }),
      tool({ toolName: "read", input: { path: "skills://story-review/resources/copyedit.md" } }),
      tool({ toolName: "skill", input: { name: "writing-principles" }, isError: true }),
    ]);

    expect([...counts.invokedSkills]).toEqual(["story-review"]);
    expect(counts.readDocuments.size).toBe(0);
    expect(counts.steps).toBe(2);
  });
});

describe("thinkingDigest", () => {
  it("names each loaded skill before the documents and steps", () => {
    const reads = [
      tool({ toolName: "read", input: { path: "ch10.md" } }),
      tool({ toolName: "read", input: { path: "ch11.md" } }),
      tool({
        toolName: "read",
        input: { path: "skills://story-review/resources/prose-critique.md" },
      }),
    ];

    expect(
      thinkingDigest(
        [tool({ toolName: "skill", input: { name: "story-review" } }), ...reads],
        "direct",
      ),
    ).toBe("Invoked 'Story Review', read 2 documents, 1 step");
    expect(
      thinkingDigest(
        [
          tool({ toolName: "skill", input: { name: "story-review" } }),
          tool({ toolName: "skill", input: { name: "writing-principles" } }),
          ...reads,
        ],
        "direct",
      ),
    ).toBe("Invoked 'Story Review' and 'Writing Principles', read 2 documents, 1 step");
  });
});
