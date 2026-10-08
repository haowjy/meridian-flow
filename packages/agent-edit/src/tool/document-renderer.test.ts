// Public read-command selection contracts and agent-facing output.
import { describe, expect, it } from "vitest";

import {
  collisionMarkdown,
  prefixCollisionFixture,
} from "../resolver/test-support/hash-collision.js";
import { context, harness, model } from "./test-support/write-tool-harness.js";

describe("read selection", () => {
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
});
