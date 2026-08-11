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
    metadata: null,
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

describe("work command phrases", () => {
  it("wears the receipt line as the complete tense, without its period", () => {
    const tool = toolView({
      toolName: "work",
      input: { command: "switch", work: "tournament-arc" },
      metadata: {
        workReceipt: {
          operation: "switch",
          category: "binding",
          changed: true,
          workId: "w1",
          workName: "Tournament arc",
          before: null,
          after: null,
          inverse: null,
        },
      },
    });
    expect(phrases(tool)).toEqual({
      active: "Switching Work…",
      complete: "Switched this conversation to Work Tournament arc",
    });
  });

  it("falls back to the client verb when no receipt arrived", () => {
    expect(
      phrases(toolView({ toolName: "work", input: { command: "create", name: "Tournament arc" } })),
    ).toEqual({
      active: "Creating a Work…",
      complete: "Created a Work",
    });
  });

  it("keeps reads to one minimal generic row", () => {
    for (const command of ["list", "show"]) {
      expect(phrases(toolView({ toolName: "work", input: { command } }))).toEqual({
        active: "Checking Work…",
        complete: "Checked Work",
      });
    }
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
    "work-read",
    "work-create",
    "work-update",
    "work-delete",
    "work-switch",
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
    "work-read": toolView({ toolName: "work", input: { command: "list" } }),
    "work-create": toolView({
      toolName: "work",
      input: { command: "create", name: "Tournament arc" },
    }),
    "work-update": toolView({
      toolName: "work",
      input: { command: "update", work: "tournament-arc" },
    }),
    "work-delete": toolView({
      toolName: "work",
      input: { command: "delete", work: "tournament-arc" },
    }),
    "work-switch": toolView({
      toolName: "work",
      input: { command: "switch", work: "tournament-arc" },
    }),
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

  // The Work family deliberately shares one glyph: the Work mark rides every
  // writer-visible Work label, and the verbs carry the distinction within the
  // family. Every command outside the family keeps its own glyph.
  it("gives each command its own glyph, with the Work family sharing the Work mark", () => {
    const workCommands = COMMANDS.filter((command) => command.startsWith("work-"));
    const otherCommands = COMMANDS.filter((command) => !command.startsWith("work-"));
    const otherGlyphs = otherCommands.map((command) => descriptorFor(SAMPLE[command]).Icon);
    expect(new Set(otherGlyphs).size).toBe(otherCommands.length);
    const workGlyphs = new Set(workCommands.map((command) => descriptorFor(SAMPLE[command]).Icon));
    expect(workGlyphs.size).toBe(1);
    const [workMark] = workGlyphs;
    expect(otherGlyphs).not.toContain(workMark);
  });
});
