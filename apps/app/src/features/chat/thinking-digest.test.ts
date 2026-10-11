/** The digest leaves changed documents to the turn receipt. */
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

it("omits successful writes and keeps reads without repeating the receipt", () => {
  const create = tool("write", "create");
  expect(thinkingDigest([create, tool("write", "replace")])).toBeNull();
  expect(thinkingDigest([tool("read"), create])).toBe("Read 1 document");
});

it("keeps skills and steps while omitting successful writes", () => {
  const skill = { ...tool("skill"), input: { name: "story-review" } };
  const failedWrite = { ...tool("write", "replace"), isError: true };
  expect(thinkingDigest([skill, tool("write", "create"), failedWrite])).toBe(
    "Invoked 'Story Review', 1 step",
  );
});

it.each(["create", "replace"])("calls a completed %s Edited in its row too", (command) => {
  const write = tool("write", command);
  expect(toolActivityPhrase(write).verb).toBe("Edited");
  expect(descriptorFor(write).pathlessTitle?.()).toBe("Edited file");
});
