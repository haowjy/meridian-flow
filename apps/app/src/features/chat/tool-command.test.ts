import type { Block } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ToolView } from "./group-delivery-segments";
import { toolCommand } from "./tool-command";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((copy, part, index) => copy + part + (values[index] ?? ""), ""),
}));

function toolView(overrides: Partial<ToolView> = {}): ToolView {
  return {
    toolCallId: "call_1",
    toolName: "write",
    input: {},
    output: null,
    status: "complete",
    isError: false,
    message: null,
    streamedOutput: null,
    keyBlock: { id: "b1", type: "tool_result", sequence: 1 } as unknown as Block,
    ...overrides,
  };
}

describe("command classification", () => {
  it.each([
    [{ command: "read" }, "read"],
    [{ command: "read", format: "full" }, "read"],
    [{ command: "read", format: "outline" }, "skim"],
    [{ command: "create" }, "create"],
    [{ command: "insert" }, "edit"],
    [{ command: "replace" }, "edit"],
    [{ command: "undo" }, "undo"],
    [{ command: "redo" }, "redo"],
    [{ command: "diff" }, "review"],
  ])("reads %o as its writer-facing command", (input, expected) => {
    expect(toolCommand(toolView({ input }))).toBe(expected);
  });

  it.each([
    ["grep", "search"],
    ["ls", "list"],
    ["invoke", "invoke"],
    ["return_result", "unknown"],
  ])("maps the %s tool to the %s command", (toolName, expected) => {
    expect(toolCommand(toolView({ toolName }))).toBe(expected);
  });
});
