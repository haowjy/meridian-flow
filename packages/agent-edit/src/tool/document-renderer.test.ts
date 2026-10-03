// Public read-command selection contracts and agent-facing output.
import { describe, expect, it } from "vitest";

import {
  collisionMarkdown,
  prefixCollisionFixture,
} from "../resolver/test-support/hash-collision.js";
import { renderAgentEditResult } from "./result-text.js";
import { hashAt } from "./test-support/assertions.js";
import { context, harness, model } from "./test-support/write-tool-harness.js";

describe("read selection", () => {
  it("returns full blocks and heading-scoped sections in the public result", async () => {
    const ctx = harness({ "chapter.md": "# Chapter\n\nAlpha sword.\n\n## Arena\n\nBeta waits." });
    const full = await ctx.core.read({ file: "chapter.md" }, context);
    expect(full.result.blocks?.[0]?.items.map((item) => item.body)).toEqual([
      "# Chapter",
      "Alpha sword.",
      "## Arena",
      "Beta waits.",
    ]);

    const headingHash = hashAt(ctx.liveDoc("chapter.md"), 2);
    const section = await ctx.core.read({ file: `chapter.md#${headingHash}` }, context);
    expect(section.result.blocks?.[0]?.items.map((item) => item.body)).toEqual([
      "## Arena",
      "Beta waits.",
    ]);

    const outline = await ctx.core.read({ file: "chapter.md", format: "outline" }, context);
    expect(outline.result.read).toEqual({ format: "outline", documentBlocks: 4 });
    expect(outline.result.blocks?.[0]?.items.map((item) => item.body)).toContain("## Arena");
  });

  it("reports the document's block count when a read returns only some blocks", async () => {
    const ctx = harness({ "chapter.md": "# Chapter\n\nAlpha sword.\n\n## Arena\n\nBeta waits." });
    const narrowed = await ctx.core.read({ file: "chapter.md", in: 1 }, context);
    expect(renderAgentEditResult(narrowed.result).split("\n")[0]).toBe(
      "status: success; path: chapter.md; blocks: 1 of 4",
    );
    const full = await ctx.core.read({ file: "chapter.md" }, context);
    expect(renderAgentEditResult(full.result).split("\n")[0]).toBe(
      "status: success; path: chapter.md; blocks: 4",
    );
  });

  it("links each outline heading by its #heading-slug", async () => {
    const ctx = harness({
      "chapter.md":
        "# Chapter\n\nAlpha.\n\n## The Arena\n\nBeta.\n\n## The Arena\n\nGamma.\n\n## Cafe\n\nDelta.",
    });
    const outline = await ctx.core.read({ file: "chapter.md", format: "outline" }, context);
    const text = renderAgentEditResult(outline.result);
    const cafeHash = hashAt(ctx.liveDoc("chapter.md"), 6);
    expect(text.split("\n").filter((line) => line.startsWith("read("))).toEqual([
      'read({"path": "chapter.md#chapter"})',
      'read({"path": "chapter.md#the-arena"})',
      'read({"path": "chapter.md#the-arena-1"})',
      // A hex-shaped slug would resolve as a block hash first, so it keeps the hash.
      `read({"path": "chapter.md#${cafeHash}"})`,
    ]);
  });

  it("returns every candidate for a colliding hash prefix", async () => {
    const ctx = harness({ "chapter.md": collisionMarkdown() });
    const fixture = prefixCollisionFixture(model, model.getBlocks(ctx.liveDoc("chapter.md")));

    const result = await ctx.core.read({ file: `chapter.md#${fixture.sharedPrefix}` }, context);
    expect(result.result.status).toBe("success");
    expect(result.result.blocks?.flatMap((group) => group.items.map((item) => item.body))).toEqual(
      fixture.candidates.map((candidate) => model.getText(candidate.block)),
    );
  });

  it("uses slug fallback for hex-shaped fragments and reports a missing fragment", async () => {
    const ctx = harness({ "chapter.md": "# cafe\n\nScene text\n\n# Next\n\nOther text" });
    const fallback = await ctx.core.read({ file: "chapter.md#cafe" }, context);
    expect(fallback.result.blocks?.[0]?.items.map((item) => item.body)).toEqual([
      "# cafe",
      "Scene text",
    ]);

    const missing = await ctx.core.read({ file: "chapter.md#deadbeef" }, context);
    expect(missing.result).toMatchObject({
      status: "not_found",
      message: expect.stringContaining('Section "#deadbeef" was not found'),
    });
  });

  it("selects radius-three windows and clamps them at document edges", async () => {
    const markdown = Array.from({ length: 9 }, (_, index) => `Block ${index + 1}`).join("\n\n");
    const ctx = harness({ "chapter.md": markdown });
    const doc = ctx.liveDoc("chapter.md");
    const readAround = async (index: number) => {
      const result = await ctx.core.read(
        { file: "chapter.md", around: hashAt(doc, index) },
        context,
      );
      return result.result.blocks?.flatMap((group) => group.items.map((item) => item.body)) ?? [];
    };

    expect(await readAround(4)).toEqual([
      "Block 2",
      "Block 3",
      "Block 4",
      "Block 5",
      "Block 6",
      "Block 7",
      "Block 8",
    ]);
    expect(await readAround(1)).toEqual(["Block 1", "Block 2", "Block 3", "Block 4", "Block 5"]);
    expect(await readAround(7)).toEqual(["Block 5", "Block 6", "Block 7", "Block 8", "Block 9"]);
  });
});
