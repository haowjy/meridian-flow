/** The digest leaves changed documents to the turn receipt. */
import { i18n } from "@lingui/core";
import { foldDigest, type ToolView } from "@meridian/thread-client";
import { beforeEach, expect, it } from "vitest";
import { thinkingDigest } from "./thinking-digest";

beforeEach(() => i18n.loadAndActivate({ locale: "en", messages: {} }));

function tool(toolName: string, command?: string): ToolView {
  const input = { path: "manuscript://chapter.md", ...(command ? { command } : {}) };
  return {
    toolName,
    input,
    toolCallId: "call-1",
    result: null,
    status: "complete",
    isError: false,
    message: null,
    streamedOutput: null,
    metadata: null,
    keyBlock: {
      id: "call-1",
      turnId: "turn",
      responseId: null,
      blockType: "tool_use",
      sequence: 1,
      content: input,
      status: "complete",
      textContent: null,
      createdAt: "2026-09-23T00:00:00.000Z",
    },
  };
}

it("omits successful writes and keeps reads without repeating the receipt", () => {
  const create = tool("write", "create");
  expect(thinkingDigest(foldDigest([create, tool("write", "replace")]))).toBeNull();
  expect(thinkingDigest(foldDigest([tool("read"), create]))).toBe("Read 1 document");
  // A section address and its whole file are one document; a different file is another.
  const read = (path: string) => ({ ...tool("read"), input: { path } });
  const sectionAndFile = [
    read("manuscript://chapter-11.md#the-pill-hall"),
    read("manuscript://chapter-11.md"),
  ];
  expect(thinkingDigest(foldDigest(sectionAndFile))).toBe("Read 1 document");
  expect(
    thinkingDigest(
      foldDigest([...sectionAndFile, read("manuscript://chapter-12.md#the-pill-hall")]),
    ),
  ).toBe("Read 2 documents");
});

it("keeps skills and steps while omitting successful writes", () => {
  const skill = { ...tool("skill"), input: { name: "story-review" } };
  const failedWrite = { ...tool("write", "replace"), isError: true };
  expect(thinkingDigest(foldDigest([skill, tool("write", "create"), failedWrite]))).toBe(
    "Invoked 'Story Review', 1 step",
  );
});
