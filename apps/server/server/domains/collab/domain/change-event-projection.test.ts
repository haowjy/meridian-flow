/** Rendered deletion offsets for writer-facing change events. */
import { createAgentEditCodec } from "@meridian/agent-edit/integration";
import { mdxCodec, unresolvedAssetPathResolver } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { detectPureDeletionOffset, renderedBodyText } from "./change-event-projection.js";

const codec = createAgentEditCodec(
  mdxCodec({ schema: buildDocumentSchema(), assetPathResolver: unresolvedAssetPathResolver }),
);

describe("detectPureDeletionOffset", () => {
  it("computes the offset in rendered text rather than markdown syntax", () => {
    const before = renderedBodyText("hash|A **bold brave** world", codec);
    const after = renderedBodyText("hash|A **bold** world", codec);
    expect(detectPureDeletionOffset(before, after)).toBe(7);
  });
});
