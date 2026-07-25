import type { Block } from "@meridian/contracts/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ToolView } from "./group-delivery-segments";
import { rendererFor } from "./tool-renderers";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((copy, part, index) => copy + part + (values[index] ?? ""), ""),
}));

function writeToolView(overrides: Partial<ToolView> = {}): ToolView {
  return {
    toolCallId: "call_write_1",
    toolName: "write",
    input: { path: "manuscript://chapter-1.md", command: "create" },
    output: null,
    status: "complete",
    isError: false,
    message: null,
    streamedOutput: null,
    keyBlock: { id: "b1", type: "tool_result", sequence: 1 } as unknown as Block,
    ...overrides,
  };
}

describe("write tool renderer", () => {
  const renderer = rendererFor("write");

  it("labels read calls as reads rather than writes", () => {
    const html = renderToStaticMarkup(
      renderer.title?.(
        writeToolView({
          input: { path: "manuscript://chapter-1.md", command: "read" },
        }),
      ),
    );
    expect(html).toContain("Read");
    expect(html).not.toContain("Wrote");
  });

  it("maps rejected writes to curated document copy", () => {
    const structuredOutput = {
      code: "tool_error",
      source: "tool",
      message:
        "status: invalid_write\n\nFile already exists: manuscript://chapter-1.md. Use overwrite=true to overwrite.",
      retryable: false,
    };
    const tool = writeToolView({
      isError: true,
      output: structuredOutput,
    });
    const html = renderToStaticMarkup(renderer.title?.(tool, { writeMode: "draft" }));
    expect(html).toContain("Couldn&#x27;t draft");
    expect(html).toContain("chapter-1");
    expect(html).not.toContain("Drafted");
    const expand = renderToStaticMarkup(renderer.expand?.(tool));
    expect(expand).toContain("That change couldn&#x27;t be made in chapter-1.");
    expect(expand).not.toMatch(/:\/\/|\.md|command=|overwrite=true/);
  });

  it("sanitizes legacy string-shaped tool errors", () => {
    const tool = writeToolView({
      isError: true,
      output:
        "status: invalid_write\nFile already exists: manuscript://chapter-1.md. Use overwrite=true to overwrite.",
    });
    const expand = renderToStaticMarkup(renderer.expand?.(tool));
    expect(expand).toContain("That change couldn&#x27;t be made in chapter-1.");
    expect(expand).not.toMatch(/:\/\/|\.md|command=|overwrite=true/);
  });

  it("never renders unknown machine detail", () => {
    const tool = writeToolView({
      isError: true,
      output: 'Run write(command="read", file="manuscript://chapters/Chapter 1.md") to re-sync.',
    });

    const expand = renderToStaticMarkup(renderer.expand?.(tool));

    expect(expand).toContain("Something went wrong while changing chapter-1.");
    expect(expand).not.toMatch(/:\/\/|\.md|command=|file=/);
  });
});

describe("unknown tool renderer", () => {
  it("shows only the humanized tool name when no path is present", () => {
    const tool = writeToolView({
      toolName: "return_result",
      input: { query: "a long developer-facing argument" },
    });

    expect(rendererFor(tool.toolName).title(tool)).toBe("Return result");
  });
});

describe("streaming tool labels", () => {
  it.each([
    ["ls", { path: "manuscript://" }, "Exploring Manuscript…"],
    ["grep", { pattern: "dragon" }, "Searching"],
  ])("uses present tense for a partial %s call", (toolName, input, expected) => {
    const tool = writeToolView({ toolName, input, status: "partial" });
    const html = renderToStaticMarkup(rendererFor(toolName).title(tool));

    expect(html).toContain(expected);
  });

  it.each([
    ["direct" as const, "Writing"],
    ["draft" as const, "Drafting"],
  ])("reflects %s write mode while a write streams", (writeMode, expected) => {
    const tool = writeToolView({ status: "partial" });
    const html = renderToStaticMarkup(rendererFor("write").title(tool, { writeMode }));

    expect(html).toContain(expected);
    expect(html).not.toContain("manuscript://");
    expect(html).not.toContain("chapter-1");
  });
});

describe("runtime tool registry", () => {
  it.each(["ls", "grep"])("registers the %s runtime tool", (toolName) => {
    expect(rendererFor(toolName)).not.toBe(rendererFor("unknown_tool"));
  });

  it("uses writer-friendly copy when ls has no path", () => {
    const tool = writeToolView({ toolName: "ls", input: {} });

    expect(rendererFor("ls").title(tool)).toBe("Explored folders");
  });

  it("reads grep's pattern input", () => {
    const tool = writeToolView({
      toolName: "grep",
      input: { pattern: "dragon", query: "wrong field" },
    });
    const html = renderToStaticMarkup(rendererFor("grep").title(tool));

    expect(html).toContain("dragon");
    expect(html).not.toContain("wrong field");
  });

  it("renders the server grep result array as curated rows", () => {
    const tool = writeToolView({
      toolName: "grep",
      output: [
        {
          uri: "manuscript://chapter-12.md",
          excerpt: "The dragon stirred beneath the mountain.",
          line: 42,
          score: 0.91,
        },
      ],
    });

    const html = renderToStaticMarkup(rendererFor("grep").expand?.(tool));

    expect(html).toContain("chapter-12");
    expect(html).not.toContain("manuscript://");
    expect(html).not.toContain(".md");
    expect(html).toContain("Line 42");
    expect(html).toContain("The dragon stirred beneath the mountain.");
    expect(html).not.toContain("0.91");
  });

  it("does not expand an empty server grep result array", () => {
    const tool = writeToolView({ toolName: "grep", output: [] });

    expect(rendererFor("grep").expand?.(tool)).toBeNull();
  });
});
