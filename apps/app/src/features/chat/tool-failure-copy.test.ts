/** A failed write tells the writer why. */
import { i18n } from "@lingui/core";
import type { ToolView } from "@meridian/thread-client";
import { beforeEach, expect, it } from "vitest";
import { documentToolFailureCopy } from "./tool-renderers";

beforeEach(() => i18n.loadAndActivate({ locale: "en", messages: {} }));

function failed(result: Record<string, unknown>): ToolView {
  const input = { command: "replace", path: "manuscript://B3X" };
  return {
    toolName: "write",
    input,
    toolCallId: "call-1",
    result: result as ToolView["result"],
    status: "complete",
    isError: true,
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

it("says why a write failed", () => {
  expect(
    documentToolFailureCopy(failed({ status: "invalid_write", rejected: "discarded_edit" })),
  ).toBe("You discarded the text it edited, so the change wasn't kept. The AI will read it again.");

  const clash = "Two files in the draft share the path B3X. Review the draft to keep one.";
  expect(documentToolFailureCopy(failed({ status: "ambiguous_path" }))).toBe(clash);
  expect(
    documentToolFailureCopy({
      ...failed({ status: "ambiguous_path" }),
      toolName: "read",
    }),
  ).toBe(clash);
});
