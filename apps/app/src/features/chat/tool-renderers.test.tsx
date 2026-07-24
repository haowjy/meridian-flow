import type { Block } from "@meridian/contracts/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ToolView } from "./group-delivery-segments";
import { rendererFor } from "./tool-renderers";

vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));

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

  it("renders success copy unchanged for a completed write", () => {
    const html = renderToStaticMarkup(renderer.title?.(writeToolView(), { writeMode: "draft" }));
    expect(html).toContain("Drafted");
    expect(html).toContain("manuscript://chapter-1.md");
    expect(renderer.expand?.(writeToolView())).toBeNull();
  });

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

  it("surfaces failure verb and error text for rejected writes", () => {
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
    expect(html).toContain("Draft write failed");
    expect(html).not.toContain("Drafted");
    const expand = renderToStaticMarkup(renderer.expand?.(tool));
    expect(expand).toContain("File already exists");
    expect(expand).toContain("overwrite=true");
  });

  it("still surfaces legacy string-shaped tool errors", () => {
    const tool = writeToolView({
      isError: true,
      output:
        "status: invalid_write\nFile already exists: manuscript://chapter-1.md. Use overwrite=true to overwrite.",
    });
    const expand = renderToStaticMarkup(renderer.expand?.(tool));
    expect(expand).toContain("overwrite=true");
  });
});

describe("unknown tool renderer", () => {
  it("shows a path without exposing other arguments", () => {
    const tool = writeToolView({
      toolName: "inspect",
      input: {
        path: "manuscript://chapter-1.md",
        query: "a long developer-facing argument",
      },
    });
    const html = renderToStaticMarkup(rendererFor(tool.toolName).title(tool));

    expect(html).toContain("inspect");
    expect(html).toContain("manuscript://chapter-1.md");
    expect(html).not.toContain("query");
    expect(html).not.toContain("developer-facing");
  });

  it("shows only the tool name when no path is present", () => {
    const tool = writeToolView({
      toolName: "inspect",
      input: { query: "a long developer-facing argument" },
    });

    expect(rendererFor(tool.toolName).title(tool)).toBe("inspect");
  });
});

describe("streaming tool labels", () => {
  it.each([
    ["read", { path: "manuscript://chapter-1.md" }, "Reading"],
    ["list", { path: "manuscript://" }, "Listing"],
    ["edit", { path: "manuscript://chapter-1.md" }, "Editing"],
    ["search", { query: "dragon" }, "Searching"],
    ["bash", { command: "wc -w chapter-1.md" }, "Running"],
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
  });
});
