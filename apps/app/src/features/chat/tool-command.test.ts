import type { Block } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ToolView } from "./group-delivery-segments";
import { toolCommand, turnWorkReceipts, workReceipt } from "./tool-command";

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
    metadata: null,
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
    ["search", "search"],
    ["ls", "list"],
    ["invoke", "invoke"],
    ["return_result", "unknown"],
  ])("maps the %s tool to the %s command", (toolName, expected) => {
    expect(toolCommand(toolView({ toolName }))).toBe(expected);
  });

  it.each([
    [{ command: "list" }, "work-read"],
    [{ command: "show", work: "tournament-arc" }, "work-read"],
    [{ command: "create", name: "Tournament arc" }, "work-create"],
    [{ command: "update", work: "tournament-arc" }, "work-update"],
    [{ command: "delete", work: "tournament-arc" }, "work-delete"],
    [{ command: "switch", work: "tournament-arc" }, "work-switch"],
  ])("reads work %o as its writer-facing command", (input, expected) => {
    expect(toolCommand(toolView({ toolName: "work", input }))).toBe(expected);
  });

  // A result-only view (provider dropped the tool_use half) has no input; the
  // receipt's category is then the server's own classification.
  it.each([
    ["read", "work-read"],
    ["binding", "work-switch"],
    ["mutate", "work-update"],
  ])("classifies a result-only work view from its receipt category %s", (category, expected) => {
    const tool = toolView({
      toolName: "work",
      input: null,
      metadata: { workReceipt: { category, line: "Updated Work Tournament arc." } },
    });
    expect(toolCommand(tool)).toBe(expected);
  });

  it("leaves a work view with neither input nor receipt unknown", () => {
    expect(toolCommand(toolView({ toolName: "work", input: null }))).toBe("unknown");
  });
});

describe("work receipts", () => {
  it("reads category, line, and inverse off the result metadata", () => {
    const tool = toolView({
      toolName: "work",
      metadata: {
        workReceipt: {
          category: "mutate",
          line: "Deleted Work Tournament arc.",
          inverse: { command: "restore", workId: "w1" },
        },
      },
    });
    expect(workReceipt(tool)).toEqual({
      category: "mutate",
      line: "Deleted Work Tournament arc.",
      inverse: { command: "restore", workId: "w1" },
    });
  });

  it("refuses a malformed receipt rather than rendering from it", () => {
    expect(workReceipt(toolView({ toolName: "work" }))).toBeNull();
    expect(
      workReceipt(toolView({ toolName: "work", metadata: { workReceipt: "yes" } })),
    ).toBeNull();
    expect(
      workReceipt(
        toolView({ toolName: "work", metadata: { workReceipt: { category: "mutate", line: "" } } }),
      ),
    ).toBeNull();
    expect(
      workReceipt(
        toolView({
          toolName: "work",
          metadata: { workReceipt: { category: "surprise", line: "Did something." } },
        }),
      ),
    ).toBeNull();
  });
});

describe("turnWorkReceipts", () => {
  function block(
    sequence: number,
    blockType: Block["blockType"],
    content: Block["content"],
  ): Block {
    return {
      id: `block-${sequence}`,
      turnId: "turn-1",
      sequence,
      blockType,
      status: "complete",
      content,
      textContent: null,
    } as Block;
  }

  it("collects every work receipt a turn's durable blocks carry, in order", () => {
    const deleteReceipt = {
      category: "mutate",
      line: "Deleted Work Tournament arc.",
      inverse: { command: "restore", workId: "w1" },
    };
    const readReceipt = { category: "read", line: "Checked Works." };
    const receipts = turnWorkReceipts([
      block(0, "text", null),
      block(1, "tool_use", {
        toolCallId: "call_1",
        toolName: "work",
        input: { command: "delete", work: "tournament-arc" },
      }),
      block(2, "tool_result", {
        toolCallId: "call_1",
        output: { slug: "tournament-arc" },
        metadata: { workReceipt: deleteReceipt },
      }),
      block(3, "tool_use", {
        toolCallId: "call_2",
        toolName: "work",
        input: { command: "list" },
      }),
      block(4, "tool_result", {
        toolCallId: "call_2",
        output: {},
        metadata: { workReceipt: readReceipt },
      }),
    ]);

    expect(receipts).toEqual([
      { category: "mutate", line: "Deleted Work Tournament arc.", inverse: deleteReceipt.inverse },
      { category: "read", line: "Checked Works.", inverse: null },
    ]);
  });

  it("finds no receipts on a turn without work results", () => {
    expect(
      turnWorkReceipts([
        block(0, "tool_use", { toolCallId: "call_1", toolName: "write", input: {} }),
        block(1, "tool_result", { toolCallId: "call_1", output: "ok" }),
      ]),
    ).toEqual([]);
  });
});
