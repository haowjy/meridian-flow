import { createAgentEditCodec } from "@meridian/agent-edit";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { detectPureDeletionOffset, renderedBodyText } from "./branch-push-transition.js";

const codec = createAgentEditCodec(mdxCodec({ schema: buildDocumentSchema() }));

describe("detectPureDeletionOffset", () => {
  it.each([
    ["middle deletion", "alpha brave world", "alpha world", 6],
    ["leading deletion", "brave world", "world", 0],
    ["trailing deletion", "brave world", "brave ", 6],
  ])("%s", (_case, before, after, expected) => {
    expect(detectPureDeletionOffset(before, after)).toBe(expected);
  });

  it.each([
    ["replacement", "alpha brave world", "alpha calm world"],
    ["insert-only", "alpha world", "alpha brave world"],
    ["equal text", "alpha world", "alpha world"],
    ["multiple splices", "abcdef", "ace"],
  ])("rejects %s", (_case, before, after) => {
    expect(detectPureDeletionOffset(before, after)).toBeNull();
  });

  it("computes the offset in rendered text rather than markdown syntax", () => {
    const before = renderedBodyText("hash|A **bold brave** world", codec);
    const after = renderedBodyText("hash|A **bold** world", codec);
    expect(detectPureDeletionOffset(before, after)).toBe(7);
  });
});
