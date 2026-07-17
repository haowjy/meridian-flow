import { createAssetPathResolver } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { Fragment, Slice } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { resolveAssetPathsFromClipboard, resolveAssetRefsForClipboard } from "./image-workflow";

describe("image clipboard translation", () => {
  it("copies asset-backed image nodes with their project-relative path", () => {
    const schema = buildDocumentSchema();
    const image = schema.node("image", { src: "asset:map-id", alt: "Realm map", title: null });
    const paragraph = schema.node("paragraph", null, image);
    const copied = resolveAssetRefsForClipboard(
      new Slice(Fragment.from(paragraph), 0, 0),
      createAssetPathResolver([["map-id", "assets/map.png"]]),
    );

    expect(copied.content.firstChild?.firstChild?.attrs.src).toBe("assets/map.png");
    expect(paragraph.firstChild?.attrs.src).toBe("asset:map-id");
  });

  it("restores known copied paths to stable refs on paste", () => {
    const schema = buildDocumentSchema();
    const paragraph = schema.node(
      "paragraph",
      null,
      schema.node("image", { src: "assets/map.png", alt: "Realm map", title: null }),
    );
    const pasted = resolveAssetPathsFromClipboard(
      new Slice(Fragment.from(paragraph), 0, 0),
      createAssetPathResolver([["map-id", "assets/map.png"]]),
    );

    expect(pasted.content.firstChild?.firstChild?.attrs.src).toBe("asset:map-id");
  });
});
