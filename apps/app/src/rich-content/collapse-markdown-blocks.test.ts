import { describe, expect, it } from "vitest";

import { collapseMarkdownBlocks, isFenceMarkdownBlock } from "./collapse-markdown-blocks";

describe("isFenceMarkdownBlock", () => {
  it("detects fenced code", () => {
    expect(isFenceMarkdownBlock("```js\nconst x = 1\n```")).toBe(true);
  });

  it("detects display math", () => {
    expect(isFenceMarkdownBlock("$$\nx^2\n$$")).toBe(true);
  });

  it("rejects prose", () => {
    expect(isFenceMarkdownBlock("Hello world.")).toBe(false);
  });
});

describe("collapseMarkdownBlocks", () => {
  it("drops whitespace-only lexer blocks", () => {
    const blocks = collapseMarkdownBlocks("Para A.\n\nPara B.");
    expect(blocks).toEqual(["Para A.\n\nPara B."]);
  });

  it("merges three paragraphs into one prose block", () => {
    const blocks = collapseMarkdownBlocks("A.\n\nB.\n\n\nC.");
    expect(blocks).toEqual(["A.\n\nB.\n\nC."]);
  });

  it("splits before fenced code", () => {
    const blocks = collapseMarkdownBlocks("Intro.\n\n```js\nx\n```\n\nOutro.");
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toBe("Intro.");
    expect(blocks[1]).toContain("```");
    expect(blocks[2]).toBe("Outro.");
  });

  it("collapses runs of more than two newlines before parsing", () => {
    const blocks = collapseMarkdownBlocks("A.\n\n\n\n\nB.");
    expect(blocks).toEqual(["A.\n\nB."]);
  });
});
