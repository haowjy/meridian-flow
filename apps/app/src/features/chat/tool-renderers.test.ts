import type { JsonValue } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { toolActivityPhrase } from "./command-descriptor";
import type { ToolView } from "./group-delivery-segments";
import { toolView } from "./report-test-fixtures";
import { documentToolFailureCopy, rendererFor } from "./tool-renderers";

function documentTool(args: {
  toolName: "read" | "write";
  input: JsonValue;
  result?: JsonValue;
  isError?: boolean;
}): ToolView {
  return {
    ...toolView({ toolCallId: "call-1", toolName: args.toolName, result: args.result ?? null }),
    input: args.input,
    isError: args.isError ?? false,
  };
}

describe("document tool rows", () => {
  it("labels a whole-document copy by its source and gives it no content card", () => {
    const input = {
      command: "copy",
      path: "manuscript://ch12.md",
      from: { path: "manuscript://ch11.md" },
    };
    const tool = documentTool({
      toolName: "write",
      input,
    });

    expect(toolActivityPhrase(tool)).toEqual({ verb: "Copied ch11.md to", parameter: "ch12.md" });
    expect(rendererFor("write").expand?.(tool)).toBeNull();
  });

  it("writes failure copy from the result's status", () => {
    const notFound = documentTool({
      toolName: "read",
      input: { path: "ch9.md" },
      result: { schema: "meridian.agent-edit.v1", command: "read", status: "document_not_found" },
      isError: true,
    });
    const refusedRead = documentTool({
      toolName: "read",
      input: { path: "ch1.md" },
      result: { schema: "meridian.agent-edit.v1", command: "read", status: "invalid_write" },
      isError: true,
    });
    expect(documentToolFailureCopy(notFound)).toBe("Couldn't find ch9.");
    expect(documentToolFailureCopy(refusedRead)).toBe("Something went wrong while reading ch1.");
  });
});

describe("skill rows", () => {
  function skillCall(args: { result: JsonValue; isError?: boolean }): ToolView {
    return {
      ...toolView({ toolCallId: "call-1", toolName: "skill", result: args.result }),
      input: { name: "story-review" },
      isError: args.isError ?? false,
    };
  }

  it("shows a skill call as invoking that skill, with nothing to expand", () => {
    const tool = skillCall({
      result:
        "skills://story-review/SKILL.md\nPaths in this skill are relative to skills://story-review/.\n\n# Story review",
    });

    expect(toolActivityPhrase(tool)).toEqual({ verb: "Invoked the Story Review skill" });
    expect(toolActivityPhrase({ ...tool, status: "partial" })).toEqual({
      verb: "Invoking the Story Review skill…",
    });
    expect(rendererFor("skill").expand).toBeUndefined();
  });

  it("names a skill file read by its file and skill, in every tense", () => {
    const read = documentTool({
      toolName: "read",
      input: { path: "skills://story-review/resources/prose-critique.md" },
    });
    const section = documentTool({
      toolName: "read",
      input: { path: "skills://creative-writing-modes/resources/prose-modes.md#line-polish" },
    });
    const missing = documentTool({
      toolName: "read",
      input: { path: "skills://story-review/resources/prose-critique/voice.md" },
      result: { schema: "meridian.agent-edit.v1", command: "read", status: "document_not_found" },
      isError: true,
    });

    expect(toolActivityPhrase(read)).toEqual({
      verb: "Read",
      parameter: "prose-critique (Story Review)",
    });
    expect(toolActivityPhrase({ ...read, status: "partial" })).toEqual({
      verb: "Reading",
      parameter: "prose-critique (Story Review)…",
    });
    expect(toolActivityPhrase(section).parameter).toBe("prose-modes (Creative Writing Modes)");
    expect(documentToolFailureCopy(missing)).toBe("Couldn't find voice (Story Review).");
  });

  it("names a failed skill call as the skill failing", () => {
    const tool = skillCall({ result: 'Unknown skill "story-review".', isError: true });

    expect(rendererFor("skill").title(tool)).toBe("Couldn't run that skill");
  });
});
