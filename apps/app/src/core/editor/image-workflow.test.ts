import { createAssetPathResolver } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { Fragment, Slice } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import {
  fileDropIntent,
  resolveAssetPathsFromClipboard,
  resolveAssetRefsForClipboard,
} from "./image-workflow";

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

describe("what a file drop means", () => {
  const file = (name: string, type: string) => new File(["x"], name, { type });

  it("takes the image out of a drop that also carries other files", () => {
    const intent = fileDropIntent([file("notes.txt", "text/plain"), file("map.png", "image/png")]);
    expect(intent).toEqual({ kind: "insert", file: expect.objectContaining({ name: "map.png" }) });
  });

  it("refuses by name, so the writer is told which file was turned away", () => {
    expect(fileDropIntent([file("chapter.pdf", "application/pdf")])).toEqual({
      kind: "refuse",
      filename: "chapter.pdf",
    });
  });

  it("has nothing to say about a drop carrying no files: that one is ProseMirror's", () => {
    expect(fileDropIntent([])).toBeNull();
  });
});
