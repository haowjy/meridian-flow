import type { JsonValue } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { descriptorFor, toolActivityPhrase } from "./command-descriptor";
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

describe("skill reads", () => {
  const skillBody = "skills://story-review/SKILL.md (read-only)\n\n# Story review";

  it("shows a read of a skill's SKILL.md as invoking that skill, with nothing to expand", () => {
    const tool = documentTool({
      toolName: "read",
      input: { path: "skills://story-review/SKILL.md" },
      result: skillBody,
    });

    expect(toolActivityPhrase(tool)).toEqual({ verb: "Invoked the Story Review skill" });
    expect(toolActivityPhrase({ ...tool, status: "partial" })).toEqual({
      verb: "Invoking the Story Review skill…",
    });
    expect(rendererFor("read").expand?.(tool)).toBeNull();
  });

  it("names a failed skill load as the skill failing, not as a missing document", () => {
    const tool = documentTool({
      toolName: "read",
      input: { path: "skills://story-review/SKILL.md" },
      result: { schema: "meridian.agent-edit.v1", command: "read", status: "document_not_found" },
      isError: true,
    });

    expect(descriptorFor(tool).failureVerb("direct")).toBe("Couldn't run that skill");
    expect(rendererFor("read").expand?.(tool)).toBeNull();
  });

  it("shows a skill resource as an ordinary read and tolerates its plain-text result", () => {
    const tool = documentTool({
      toolName: "read",
      input: { path: "skills://story-review/references/beats.md" },
      result: "skills://story-review/references/beats.md (read-only)\n\nBeat one.",
    });

    expect(toolActivityPhrase(tool)).toEqual({ verb: "Read", parameter: "beats.md" });
    expect(rendererFor("read").expand?.(tool)).toBeNull();
  });
});
