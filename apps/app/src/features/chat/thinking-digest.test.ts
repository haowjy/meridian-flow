/** Guards document counts against section addresses splitting one file into two. */
import { expect, it } from "vitest";
import type { ToolView } from "./group-delivery-segments";
import { countFoldTools } from "./thinking-digest";

function tool(toolName: "read" | "write", path: string): ToolView {
  return {
    toolCallId: path,
    toolName,
    input: toolName === "write" ? { command: "replace", path } : { path },
    result: null,
    status: "complete",
    isError: false,
    message: null,
    streamedOutput: null,
    metadata: null,
    keyBlock: {
      id: path,
      turnId: "turn",
      responseId: null,
      blockType: "tool_use",
      sequence: 0,
      content: {},
      status: "complete",
      textContent: null,
      createdAt: "2026-10-11T00:00:00.000Z",
    },
  };
}

it.each([
  "read",
  "write",
] as const)("%s counts sections and their file once, without merging different documents", (command) => {
  const tools = [
    tool(command, "manuscript://chapter-11.md#the-pill-hall"),
    tool(command, "chapter-11.md"),
  ];
  const documents = (input: ToolView[]) => {
    const counts = countFoldTools(input);
    return command === "read" ? counts.readDocuments : counts.editedDocuments;
  };

  expect([...documents(tools)]).toEqual(["manuscript://chapter-11.md"]);
  expect(
    documents([...tools, tool(command, "manuscript://chapter-12.md#the-pill-hall")]).size,
  ).toBe(2);
});
