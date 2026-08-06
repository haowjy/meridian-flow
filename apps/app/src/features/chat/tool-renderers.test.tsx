import type { Block } from "@meridian/contracts/protocol";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ToolView } from "./group-delivery-segments";
import { rendererFor } from "./tool-renderers";

/** Expands are deferred; a test opens one the way the reader does. */
function expandMarkup(build: (() => ReactNode) | null | undefined): string {
  if (!build) throw new Error("row offered no expand");
  return renderToStaticMarkup(build());
}

/**
 * Row titles are composed of styled spans separated by flex gaps; assertions
 * read them the way a writer does, with element boundaries as word breaks.
 */
function titleText(node: ReactNode): string {
  return renderToStaticMarkup(node)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((copy, part, index) => copy + part + (values[index] ?? ""), ""),
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
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
    metadata: null,
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
    const expand = expandMarkup(renderer.expand?.(tool));
    expect(expand).toContain("That change couldn&#x27;t be made in chapter-1.");
    expect(expand).not.toMatch(/:\/\/|\.md|command=|overwrite=true/);
  });

  it("never renders unknown machine detail", () => {
    const tool = writeToolView({
      isError: true,
      output: 'Run write(command="read", file="manuscript://chapters/Chapter 1.md") to re-sync.',
    });

    const expand = expandMarkup(renderer.expand?.(tool));

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

describe("work tool renderer", () => {
  const renderer = rendererFor("work");

  it("renders the receipt line as the row, in Work names", () => {
    const tool = writeToolView({
      toolName: "work",
      input: { command: "create", name: "Tournament arc" },
      metadata: {
        workReceipt: {
          category: "mutate",
          line: "Created Work Tournament arc.",
          inverse: { command: "delete", workId: "w1" },
        },
      },
    });
    expect(titleText(renderer.title(tool))).toBe("Created Work Tournament arc");
    // A successful receipt is the whole story: no chevron behind it.
    expect(renderer.expand?.(tool)).toBeNull();
  });

  it("keeps reads to the minimal generic row", () => {
    const tool = writeToolView({ toolName: "work", input: { command: "list" } });
    expect(titleText(renderer.title(tool))).toBe("Checked Works");
    expect(renderer.expand?.(tool)).toBeNull();
  });

  it("renders a failure as its own claim with the structured message behind it", () => {
    const tool = writeToolView({
      toolName: "work",
      input: { command: "delete", work: "tournament-arc" },
      isError: true,
      output: {
        code: "work_delete_blocked",
        source: "tool",
        message: "Work Tournament arc still holds notes. Move or delete them first.",
        retryable: false,
      },
    });
    expect(titleText(renderer.title(tool))).toBe("Couldn&#x27;t delete that Work");
    const expand = expandMarkup(renderer.expand?.(tool));
    expect(expand).toContain("Work Tournament arc still holds notes.");
  });
});

describe("streaming tool labels", () => {
  it.each([
    ["ls", { path: "manuscript://" }, "Exploring Manuscript…"],
    ["search", { pattern: "dragon" }, "Searching"],
  ])("uses present tense for a partial %s call", (toolName, input, expected) => {
    const tool = writeToolView({ toolName, input, status: "partial" });

    expect(titleText(rendererFor(toolName).title(tool))).toContain(expected);
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
  it.each(["ls", "search"])("registers the %s runtime tool", (toolName) => {
    expect(rendererFor(toolName)).not.toBe(rendererFor("unknown_tool"));
  });

  it("uses writer-friendly copy when ls has no path", () => {
    const tool = writeToolView({ toolName: "ls", input: {} });

    expect(titleText(rendererFor("ls").title(tool))).toBe("Explored folders");
  });

  it("reads search's pattern input", () => {
    const tool = writeToolView({
      toolName: "search",
      input: { pattern: "dragon", query: "wrong field" },
    });
    const html = renderToStaticMarkup(rendererFor("search").title(tool));

    expect(html).toContain("dragon");
    expect(html).not.toContain("wrong field");
  });

  it("renders the server search result array as curated rows", () => {
    const tool = writeToolView({
      toolName: "search",
      input: { pattern: "dragon" },
      output: [
        {
          uri: "manuscript://chapter-12.md",
          matches: [{ excerpt: "The dragon stirred beneath the mountain." }],
          matchCount: 1,
          score: 0.91,
        },
      ],
    });

    const html = expandMarkup(rendererFor("search").expand?.(tool));

    expect(html).toContain("chapter-12");
    expect(html).not.toContain("manuscript://");
    expect(html).not.toContain(".md");
    // Chapters are not line-addressed: a line number is developer vocabulary.
    expect(html).not.toContain("Line 42");
    // The passage renders in parts so the match can carry weight.
    expect(html).toContain("The ");
    expect(html).toContain(">dragon<");
    expect(html).toContain(" stirred beneath the mountain.");
    expect(html).not.toContain("0.91");
  });

  it("weights the searched words inside the passage", () => {
    const tool = writeToolView({
      toolName: "search",
      input: { pattern: "Elara" },
      output: [
        {
          uri: "manuscript://chapter-2.md",
          matches: [{ excerpt: "Then elara spoke the name." }],
          matchCount: 1,
        },
      ],
    });

    const html = expandMarkup(rendererFor("search").expand?.(tool));

    // The document's own casing wins, matched case-insensitively.
    expect(html).toContain("font-semibold");
    expect(html).toContain(">elara<");
    expect(html).toContain("Then ");
    expect(html).toContain(" spoke the name.");
  });

  it("centres a long passage on the match and marks the cut", () => {
    const lead = "A very long run-up that the writer does not need to read again, and then ";
    const tool = writeToolView({
      toolName: "search",
      input: { pattern: "gate" },
      output: [
        {
          uri: "manuscript://chapter-2.md",
          matches: [{ excerpt: `${lead}the gate opened.` }],
          matchCount: 1,
        },
      ],
    });

    const html = expandMarkup(rendererFor("search").expand?.(tool));

    expect(html).toContain("…");
    expect(html).not.toContain("A very long run-up");
    expect(html).toContain(">gate<");
    expect(html).toContain(" opened.");
  });

  it("shows the whole line when the pattern is unknown", () => {
    const tool = writeToolView({
      toolName: "search",
      output: [
        {
          uri: "manuscript://chapter-2.md",
          matches: [{ excerpt: "The hollow gate stood." }],
          matchCount: 1,
        },
      ],
    });

    expect(expandMarkup(rendererFor("search").expand?.(tool))).toContain("The hollow gate stood.");
  });

  it("states the bound when the expand clips a longer result list", () => {
    const tool = writeToolView({
      toolName: "search",
      output: Array.from({ length: 42 }, (_, index) => ({
        uri: `manuscript://chapter-${index + 1}.md`,
        matches: [{ excerpt: "The dragon stirred beneath the mountain." }],
        matchCount: 1,
      })),
    });

    const html = expandMarkup(rendererFor("search").expand?.(tool));

    // A fact about the payload, never an invitation ("Showing…" is systems voice).
    expect(html).toContain("4 of 42");
    expect(html).not.toContain("Showing");
    expect(html).toContain("chapter-4");
    expect(html).not.toContain("chapter-5");
  });

  it("states no bound when nothing was clipped", () => {
    const tool = writeToolView({
      toolName: "search",
      output: [
        {
          uri: "manuscript://chapter-12.md",
          matches: [{ excerpt: "The dragon stirred." }],
          matchCount: 1,
        },
      ],
    });

    expect(expandMarkup(rendererFor("search").expand?.(tool))).not.toContain(" of ");
  });

  it("offers no chevron for a search that found nothing", () => {
    // A chevron is a promise, and an empty result set has nothing to promise.
    // Payloads the contract cannot produce are not pinned here: the row trusts
    // the contract, and a second validator beside the real one is how the
    // cheap check and the parser came to disagree in the first place.
    expect(rendererFor("search").expand?.(writeToolView({ toolName: "search", output: [] }))).toBe(
      null,
    );
    expect(
      rendererFor("search").expand?.(writeToolView({ toolName: "search", output: undefined })),
    ).toBe(null);
    expect(
      rendererFor("search").expand?.(writeToolView({ toolName: "search", output: "not a list" })),
    ).toBe(null);
  });

  it("shows the passage a read returned, without its block hashes", () => {
    const tool = writeToolView({
      input: { path: "manuscript://chapter-3.md", command: "read" },
      output: "10aa|# The Long Descent\n7f21|The stair spiralled downward.",
    });

    const html = expandMarkup(rendererFor("write").expand?.(tool));

    expect(html).toContain("The Long Descent");
    expect(html).toContain("The stair spiralled downward.");
    expect(html).not.toContain("10aa");
    expect(html).not.toContain("|");
  });

  it("shows a skim as the headings it saw, never the locator lines", () => {
    const tool = writeToolView({
      input: { path: "manuscript://chapter-3.md", command: "read", format: "outline" },
      output: [
        "10aa|# The Long Descent",
        'write(command="read", file="manuscript://chapter-3.md#10aa")',
        "7f21|## What the forge remembered",
        'write(command="read", file="manuscript://chapter-3.md#7f21")',
      ].join("\n"),
    });

    const html = expandMarkup(rendererFor("write").expand?.(tool));

    expect(html).toContain("The Long Descent");
    expect(html).toContain("What the forge remembered");
    // The locator is how the model reads further. It is not writer vocabulary.
    expect(html).not.toContain("write(command=");
    expect(html).not.toContain("#");
  });

  it("caps a long outline and states what it left out", () => {
    const output = Array.from({ length: 23 }, (_, index) =>
      [`h${index}|## Section ${index + 1}`, `write(command="read", file="x.md#h${index}")`].join(
        "\n",
      ),
    ).join("\n");
    const tool = writeToolView({
      input: { path: "manuscript://long.md", command: "read", format: "outline" },
      output,
    });

    const html = expandMarkup(rendererFor("write").expand?.(tool));

    expect(html).toContain("Section 8");
    expect(html).not.toContain("Section 9");
    expect(html).toContain("8 of 23");
    // A clipped outline is a discrete list: it states a count, and its door is
    // the row title's, not a second one at a fade.
    expect(html).not.toContain("Open long");
  });

  it("falls back to prose when an outline read found no headings", () => {
    // renderOutline returns whole blocks for a document with no headings, so
    // the payload really is prose.
    const tool = writeToolView({
      input: { path: "manuscript://notes.md", command: "read", format: "outline" },
      output: "10aa|Just a paragraph, no headings anywhere.",
    });

    const html = expandMarkup(rendererFor("write").expand?.(tool));

    expect(html).toContain("Just a paragraph, no headings anywhere.");
  });

  it("offers no read expand for an empty document", () => {
    const tool = writeToolView({
      input: { path: "manuscript://empty.md", command: "read" },
      output: "",
    });

    expect(rendererFor("write").expand?.(tool)).toBe(null);
  });

  it("shows what a write submitted, from the input rather than the output", () => {
    const tool = writeToolView({
      input: {
        path: "manuscript://chapter-3.md",
        command: "insert",
        content: "# The Long Descent\n\nThe stair spiralled downward.",
      },
      output: "status: ok\n\napplied 1 change",
    });

    const html = expandMarkup(rendererFor("write").expand?.(tool));

    // Only the input holds the exact content; the output is formatted status.
    expect(html).toContain("The stair spiralled downward.");
    expect(html).not.toContain("applied 1 change");
    // Recessed quoted surface, never the diff palette: those tokens mean a
    // real, persisted change, which is the receipt card's claim, not this one.
    expect(html).toContain("bg-muted");
    expect(html).not.toMatch(/diff-added|diff-removed|review-added|review-removed/);
  });

  it("offers no write expand when nothing was submitted", () => {
    const tool = writeToolView({ input: { path: "manuscript://a.md", command: "undo" } });

    expect(rendererFor("write").expand?.(tool)).toBe(null);
  });

  it("keeps the failure text when a write failed", () => {
    const tool = writeToolView({
      input: { path: "manuscript://chapter-3.md", command: "insert", content: "Some prose." },
      isError: true,
      output: { status: "not_found", message: "" } as never,
    });

    const html = expandMarkup(rendererFor("write").expand?.(tool));

    expect(html).toContain("Couldn&#x27;t find chapter-3.");
    expect(html).not.toContain("Some prose.");
  });

  it("maps an ls listing to doors and inert folders", () => {
    const tool = writeToolView({
      toolName: "ls",
      output: [
        { uri: "manuscript://arc-one", kind: "directory" },
        { uri: "manuscript://chapter-1.md", kind: "file", editable: true },
      ],
    });

    const html = expandMarkup(rendererFor("ls").expand?.(tool));

    expect(html).toContain("arc-one");
    expect(html).toContain("chapter-1");
    // Never the words "file" or "folder": the glyph carries that.
    expect(html).not.toMatch(/>\s*(file|folder|directory)\s*</i);
    expect(html).not.toContain("manuscript://");
  });

  it("states the bound when a listing is capped at eight", () => {
    const tool = writeToolView({
      toolName: "ls",
      output: Array.from({ length: 23 }, (_, index) => ({
        uri: `manuscript://chapter-${index + 1}.md`,
        kind: "file",
      })),
    });

    const html = expandMarkup(rendererFor("ls").expand?.(tool));

    expect(html).toContain("8 of 23");
    expect(html).toContain("chapter-8");
    expect(html).not.toContain("chapter-9");
  });

  it("offers no ls expand for an empty folder", () => {
    expect(rendererFor("ls").expand?.(writeToolView({ toolName: "ls", output: [] }))).toBe(null);
  });

  it("does not expand an empty server search result array", () => {
    const tool = writeToolView({ toolName: "search", output: [] });

    expect(rendererFor("search").expand?.(tool)).toBeNull();
  });
});
