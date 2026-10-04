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
