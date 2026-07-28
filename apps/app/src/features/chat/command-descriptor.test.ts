import type { Block } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";

import { descriptorFor, toolActivityAnnouncement, toolActivityPhrase } from "./command-descriptor";
import type { ToolView } from "./group-delivery-segments";
import type { ToolCommand } from "./tool-command";

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

/** Both tenses as the screen reader hears them. */
function phrases(tool: ToolView, writeMode?: "direct" | "draft") {
  return {
    active: toolActivityAnnouncement(toolActivityPhrase({ ...tool, status: "partial" }, writeMode)),
    complete: toolActivityAnnouncement(
      toolActivityPhrase({ ...tool, status: "complete" }, writeMode),
    ),
  };
}

describe("the verb table", () => {
  it("says a skim was a skim, never a read", () => {
    expect(phrases(toolView({ input: { command: "read", format: "outline" } }))).toEqual({
      active: "Skimming…",
      complete: "Skimmed",
    });
  });

  it.each([
    ["undo", "Undoing…", "Undid"],
    ["redo", "Redoing…", "Redid"],
  ])("says %s reverted rather than edited, in both write modes", (command, active, complete) => {
    for (const writeMode of ["direct", "draft"] as const) {
      expect(phrases(toolView({ input: { command } }), writeMode)).toEqual({ active, complete });
    }
  });

  it("names the skill it invoked rather than claiming a run finished", () => {
    expect(
      phrases(toolView({ toolName: "invoke", input: { skillname: "story-outline" } })),
    ).toEqual({
      active: "Invoking the Story Outline skill…",
      complete: "Invoked the Story Outline skill",
    });
  });

  it.each([
    ["direct" as const, "Writing…", "Wrote"],
    ["draft" as const, "Drafting…", "Drafted"],
  ])("reflects %s write mode for a create", (writeMode, active, complete) => {
    expect(phrases(toolView({ input: { command: "create" } }), writeMode)).toEqual({
      active,
      complete,
    });
  });
});

describe("announcements match the visible row", () => {
  it("announces the folder an ls call actually explored", () => {
    // The shipped divergence: the row read `Exploring characters…` while the
    // screen reader heard `Exploring folders…`.
    expect(phrases(toolView({ toolName: "ls", input: { path: "kb://characters" } }))).toEqual({
      active: "Exploring characters…",
      complete: "Explored characters",
    });
  });

  it("announces the pattern a search used", () => {
    expect(phrases(toolView({ toolName: "search", input: { pattern: "Elara" } }))).toEqual({
      active: "Searching “Elara”…",
      complete: "Searched “Elara”",
    });
  });

  it("falls back to a bound-free phrase when the call names nothing", () => {
    expect(phrases(toolView({ toolName: "ls", input: {} }))).toEqual({
      active: "Exploring folders…",
      complete: "Explored folders",
    });
  });
});

describe("every command carries a full descriptor", () => {
  const COMMANDS: ToolCommand[] = [
    "read",
    "skim",
    "create",
    "edit",
    "undo",
    "redo",
    "review",
    "search",
    "list",
    "invoke",
    "unknown",
  ];
  const SAMPLE: Record<ToolCommand, ToolView> = {
    read: toolView({ input: { command: "read" } }),
    skim: toolView({ input: { command: "read", format: "outline" } }),
    create: toolView({ input: { command: "create" } }),
    edit: toolView({ input: { command: "insert" } }),
    undo: toolView({ input: { command: "undo" } }),
    redo: toolView({ input: { command: "redo" } }),
    review: toolView({ input: { command: "diff" } }),
    search: toolView({ toolName: "search", input: { pattern: "Elara" } }),
    list: toolView({ toolName: "ls", input: {} }),
    invoke: toolView({ toolName: "invoke", input: { skillname: "outline" } }),
    unknown: toolView({ toolName: "return_result" }),
  };

  it.each(COMMANDS)("%s has a glyph, both tenses, and a failure verb", (command) => {
    const tool = SAMPLE[command];
    const descriptor = descriptorFor(tool);

    expect(descriptor.Icon).toBeTruthy();
    expect(descriptor.failureVerb("direct")).not.toBe("");
    expect(phrases(tool).active).not.toBe("");
    expect(phrases(tool).complete).not.toBe("");
  });

  it("never lets a failure reuse the success verb", () => {
    for (const command of COMMANDS) {
      const tool = SAMPLE[command];
      expect(descriptorFor(tool).failureVerb("direct")).not.toBe(phrases(tool).complete);
    }
  });

  it("gives each command its own glyph", () => {
    const glyphs = COMMANDS.map((command) => descriptorFor(SAMPLE[command]).Icon);
    expect(new Set(glyphs).size).toBe(COMMANDS.length);
  });
});
