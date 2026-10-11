/** Tool activity describes edits, independent of the Work's write mode. */
import { i18n } from "@lingui/core";
import { beforeEach, expect, it } from "vitest";
import { descriptorFor, toolActivityPhrase } from "./command-descriptor";
import type { ToolView } from "./group-delivery-segments";
import { block } from "./report-test-fixtures";
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
    keyBlock: block("call-1", 1, "tool_use", input),
  };
}

it("counts a created document as an edit and carries the document noun after reads", () => {
  const create = tool("write", "create");
  expect(thinkingDigest([create])).toBe("Edited 1 document");
  expect(thinkingDigest([tool("read"), create, tool("write", "replace")])).toBe(
    "Read 1 document, edited 1",
  );
});

it.each(["create", "replace"])("calls a completed %s Edited in its row too", (command) => {
  const write = tool("write", command);
  expect(toolActivityPhrase(write).verb).toBe("Edited");
  expect(descriptorFor(write).pathlessTitle?.()).toBe("Edited file");
});
