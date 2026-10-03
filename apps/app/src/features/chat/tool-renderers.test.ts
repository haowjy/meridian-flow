import type { JsonValue } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { toolActivityPhrase } from "./command-descriptor";
import type { ToolView } from "./group-delivery-segments";
import { toolView } from "./report-test-fixtures";
import { documentToolFailureCopy, rendererFor } from "./tool-renderers";

function documentTool(args: {
  toolName: "read" | "write";
  input: JsonValue;
  output?: JsonValue;
  result?: JsonValue;
  isError?: boolean;
}): ToolView {
  return {
    ...toolView({ toolCallId: "call-1", toolName: args.toolName, output: args.output ?? null }),
    input: args.input,
    result: args.result ?? null,
    isError: args.isError ?? false,
  };
}

function readResult(format: "full" | "outline", bodies: string[]): JsonValue {
  return {
    schema: "meridian.agent-edit.v1",
    command: "read",
    status: "success",
    phase: "committed",
    path: "ch1.md",
    read: { format },
    blocks: [
      {
        extent: "full",
        relation: "document",
        items: bodies.map((body, index) => ({ hash: `h${index}`, body })),
      },
    ],
  };
}

describe("document tool rows", () => {
  it("opens a read card from the typed result, not the model's text", () => {
    const tool = documentTool({
      toolName: "read",
      input: { path: "ch1.md" },
      output: "status: success; path: ch1.md; blocks: 1\n\nh0|The lantern guttered.",
      result: readResult("full", ["The lantern guttered."]),
    });

    expect(toolActivityPhrase(tool)).toEqual({ verb: "Read", parameter: "ch1.md" });
    expect(rendererFor("read").expand?.(tool)).toBeTypeOf("function");
  });

  it("labels an outline read as a skim and opens its headings", () => {
    const tool = documentTool({
      toolName: "read",
      input: { path: "ch1.md", format: "outline" },
      result: readResult("outline", ["# Chapter One", "## The Gate"]),
    });

    expect(toolActivityPhrase(tool).verb).toBe("Skimmed");
    expect(rendererFor("read").expand?.(tool)).toBeTypeOf("function");
  });

  it("labels remove as an edit", () => {
    const tool = documentTool({
      toolName: "write",
      input: { command: "remove", path: "ch1.md#the-gate" },
    });

    expect(toolActivityPhrase(tool).verb).toBe("Edited");
  });

  it("labels a whole-document copy by its source and gives it no content card", () => {
    const input = {
      command: "copy",
      path: "manuscript://ch12.md",
      from: { path: "manuscript://ch11.md" },
    };
    const tool = documentTool({
      toolName: "write",
      input,
      output: "status: success; path: ch12.md; write: w1; copied: 3 blocks from ch11.md",
    });

    expect(toolActivityPhrase(tool)).toEqual({ verb: "Copied ch11.md to", parameter: "ch12.md" });
    expect(toolActivityPhrase({ ...tool, status: "partial" })).toEqual({
      verb: "Copying ch11.md to",
      parameter: "ch12.md…",
    });
    expect(rendererFor("write").expand?.(tool)).toBeNull();
  });

  it("labels insert and replace with from as copies, not as written text", () => {
    for (const command of ["insert", "replace"]) {
      const tool = documentTool({
        toolName: "write",
        input: { command, path: "ch12.md", from: { path: "ch11.md", in: "#the-gate" } },
      });
      expect(toolActivityPhrase(tool)).toEqual({
        verb: "Copied from ch11.md into",
        parameter: "ch12.md",
      });
    }
    const typed = documentTool({
      toolName: "write",
      input: { command: "insert", path: "ch12.md", content: "New line." },
    });
    expect(toolActivityPhrase(typed).verb).toBe("Edited");
  });

  it("names the source when a copy's document is missing", () => {
    const missing = (command: string) =>
      documentTool({
        toolName: "write",
        input: { command, path: "ch12.md", from: { path: "ch11.md" } },
        result: { schema: "meridian.agent-edit.v1", command, status: "document_not_found" },
        isError: true,
      });

    expect(documentToolFailureCopy(missing("copy"))).toBe("Couldn't find ch11.");
    expect(documentToolFailureCopy(missing("insert"))).toBe("Couldn't find ch11 or ch12.");
  });

  it("renders an old write(command: read) row without a card", () => {
    const tool = documentTool({
      toolName: "write",
      input: { command: "read", path: "ch1.md" },
      output: "h0|The lantern guttered.",
    });

    expect(toolActivityPhrase(tool).verb).toBe("Write");
    expect(rendererFor("write").expand?.(tool)).toBeNull();
  });

  it("writes failure copy from the result's status", () => {
    const notFound = documentTool({
      toolName: "read",
      input: { path: "ch9.md" },
      output: "status: document_not_found; path: ch9.md",
      result: { schema: "meridian.agent-edit.v1", command: "read", status: "document_not_found" },
      isError: true,
    });
    const refusedRead = documentTool({
      toolName: "read",
      input: { path: "ch1.md" },
      result: { schema: "meridian.agent-edit.v1", command: "read", status: "invalid_write" },
      isError: true,
    });
    const refusedWrite = documentTool({
      toolName: "write",
      input: { command: "replace", path: "ch1.md" },
      result: { schema: "meridian.agent-edit.v1", command: "replace", status: "invalid_write" },
      isError: true,
    });

    const binaryRead = documentTool({
      toolName: "read",
      input: { path: "scan.pdf" },
      result: { schema: "meridian.agent-edit.v1", command: "read", status: "binary_file" },
      isError: true,
    });
    const binarySource = documentTool({
      toolName: "write",
      input: { command: "insert", path: "ch1.md", from: { path: "scan.pdf", in: 1 } },
      result: { schema: "meridian.agent-edit.v1", command: "insert", status: "binary_file" },
      isError: true,
    });

    expect(documentToolFailureCopy(notFound)).toBe("Couldn't find ch9.");
    expect(documentToolFailureCopy(binaryRead)).toBe("scan is a binary file.");
    expect(documentToolFailureCopy(binarySource)).toBe("scan is a binary file.");
    expect(documentToolFailureCopy(refusedRead)).toBe("Something went wrong while reading ch1.");
    expect(documentToolFailureCopy(refusedWrite)).toBe("That change couldn't be made in ch1.");
  });
});
