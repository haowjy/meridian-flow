// Public read-command selection contracts and agent-facing output.
import { describe, expect, it } from "vitest";

import {
  collisionMarkdown,
  prefixCollisionFixture,
} from "../resolver/test-support/hash-collision.js";
import { hashAt } from "./test-support/assertions.js";
import { context, harness, model } from "./test-support/write-tool-harness.js";

describe('write(command="read") selection', () => {
  it("returns full blocks and heading-scoped sections in the public result", async () => {
    const ctx = harness({ "chapter.md": "# Chapter\n\nAlpha sword.\n\n## Arena\n\nBeta waits." });
    const full = await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    expect(full.result.blocks?.[0]?.items.map((item) => item.body)).toEqual([
      "# Chapter",
      "Alpha sword.",
      "## Arena",
      "Beta waits.",
    ]);

    const headingHash = hashAt(ctx.liveDoc("chapter.md"), 2);
    const section = await ctx.core.write(
      { command: "read", file: `chapter.md#${headingHash}` },
      context,
    );
    expect(section.result.blocks?.[0]?.items.map((item) => item.body)).toEqual([
      "## Arena",
      "Beta waits.",
    ]);

    const outline = await ctx.core.write(
      { command: "read", file: "chapter.md", format: "outline" },
      context,
    );
    expect(outline.result.read).toEqual({ format: "outline" });
    expect(outline.result.blocks?.[0]?.items.map((item) => item.body)).toContain("## Arena");
  });

  it("returns every candidate for a colliding hash prefix", async () => {
    const ctx = harness({ "chapter.md": collisionMarkdown() });
    const fixture = prefixCollisionFixture(model, model.getBlocks(ctx.liveDoc("chapter.md")));

    const result = await ctx.core.write(
      { command: "read", file: `chapter.md#${fixture.sharedPrefix}` },
      context,
    );
    expect(result.result.status).toBe("success");
    expect(result.result.blocks?.flatMap((group) => group.items.map((item) => item.body))).toEqual(
      fixture.candidates.map((candidate) => model.getText(candidate.block)),
    );
  });

  it("uses slug fallback for hex-shaped fragments and reports a missing fragment", async () => {
    const ctx = harness({ "chapter.md": "# cafe\n\nScene text\n\n# Next\n\nOther text" });
    const fallback = await ctx.core.write({ command: "read", file: "chapter.md#cafe" }, context);
    expect(fallback.result.blocks?.[0]?.items.map((item) => item.body)).toEqual([
      "# cafe",
      "Scene text",
    ]);

    const missing = await ctx.core.write({ command: "read", file: "chapter.md#deadbeef" }, context);
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
      const result = await ctx.core.write(
        { command: "read", file: "chapter.md", around: hashAt(doc, index) },
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
