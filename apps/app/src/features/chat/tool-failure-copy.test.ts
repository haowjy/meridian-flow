/** A failed write tells the writer why, and every undo/redo refusal has its own plain copy. */
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

it("says why a write failed, and gives every undo and redo refusal its own copy", () => {
  expect(
    documentToolFailureCopy(failed({ status: "invalid_write", rejected: "discarded_edit" })),
  ).toBe("You discarded the text it edited, so the change wasn't kept. The AI will read it again.");

  const statuses = [
    "cant_undo_applied",
    "cant_undo_discarded",
    "cant_undo_changed",
    "cant_undo_held",
    "cant_undo_elsewhere",
    "cant_redo_applied",
    "cant_redo_discarded",
    "cant_redo_changed",
    "cant_redo_held",
    "cant_redo_elsewhere",
    "cant_redo_users_undo",
  ];
  const copies = statuses.map((status) => documentToolFailureCopy(failed({ status })));
  expect(new Set(copies).size).toBe(statuses.length);
  for (const copy of copies) expect(copy).not.toContain("Something went wrong");
});
