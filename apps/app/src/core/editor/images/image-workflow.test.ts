import { createAssetPathResolver } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { Fragment, Slice } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import {
  fileDropIntent,
  imageFilenameFromUrl,
  pastedContentRange,
  pastedImageLinkRange,
  resolveAssetRefsForClipboard,
  resolveImagesFromClipboard,
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
    const pasted = resolveImagesFromClipboard(
      new Slice(Fragment.from(paragraph), 0, 0),
      schema,
      createAssetPathResolver([["map-id", "assets/map.png"]]),
    );

    expect(pasted.slice.content.firstChild?.firstChild?.attrs.src).toBe("asset:map-id");
    expect(pasted.imports).toEqual([]);
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

describe("images a paste only pointed at", () => {
  const schema = buildDocumentSchema();

  const pastedParagraph = (...content: Parameters<typeof schema.node>[2][]) =>
    new Slice(Fragment.from(schema.node("paragraph", null, content as never)), 0, 0);

  /** The paste transform as the editor composes it, with no copied paths in play. */
  const pasted = (slice: Slice) =>
    resolveImagesFromClipboard(slice, schema, createAssetPathResolver([]));

  it("lands a link to the address instead of an image the project does not own", () => {
    const external = schema.node("image", {
      src: "https://example.com/x.png",
      alt: "A map",
      title: null,
    });
    const { slice, imports } = pasted(pastedParagraph(external));

    const landed = slice.content.firstChild?.firstChild;
    expect(landed?.type.name).toBe("text");
    expect(landed?.text).toBe("https://example.com/x.png");
    expect(landed?.marks[0]?.type.name).toBe("link");
    expect(landed?.marks[0]?.attrs.href).toBe("https://example.com/x.png");
    expect(imports).toEqual([{ url: "https://example.com/x.png", alt: "A map" }]);
  });

  it("leaves an asset-backed image alone, however deep it sits", () => {
    const owned = schema.node("image", { src: "asset:map-id", alt: null, title: null });
    const quote = schema.node("blockquote", null, schema.node("paragraph", null, owned));
    const { slice, imports } = pasted(new Slice(Fragment.from(quote), 0, 0));

    expect(slice.content.firstChild?.firstChild?.firstChild?.attrs.src).toBe("asset:map-id");
    expect(imports).toEqual([]);
  });

  it("keeps the prose around the picture, and takes every picture in the paste", () => {
    const first = schema.node("image", { src: "https://a.example/1.png", alt: null, title: null });
    const second = schema.node("image", { src: "https://a.example/2.png", alt: null, title: null });
    const { slice, imports } = pasted(
      pastedParagraph(schema.text("Before "), first, schema.text(" and "), second),
    );

    expect(slice.content.firstChild?.textContent).toBe(
      "Before https://a.example/1.png and https://a.example/2.png",
    );
    expect(imports.map((pending) => pending.url)).toEqual([
      "https://a.example/1.png",
      "https://a.example/2.png",
    ]);
  });
});

describe("finding the link a paste left behind", () => {
  const schema = buildDocumentSchema();
  const url = "https://example.com/x.png";

  /** A paste of the degraded link into the second paragraph, as a transaction. */
  function pasteLink() {
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("paragraph", null, schema.text("Chapter one.")),
        schema.node("paragraph", null, schema.text("Look: ")),
      ]),
    });
    const at = state.doc.content.size - 1;
    const transaction = state.tr
      .setSelection(TextSelection.create(state.doc, at))
      .replaceSelectionWith(schema.text(url, [schema.marks.link.create({ href: url })]), false);
    return { state, transaction };
  }

  it("reports where the pasted content landed", () => {
    const { state, transaction } = pasteLink();
    const range = pastedContentRange(transaction);
    expect(range).not.toBeNull();

    const after = state.apply(transaction);
    expect(range && after.doc.textBetween(range.from, range.to)).toBe(url);
    // A transaction that changed nothing pasted nothing.
    expect(pastedContentRange(after.tr)).toBeNull();
  });

  it("finds the link by its address, and refuses one the writer already removed", () => {
    const { state, transaction } = pasteLink();
    const after = state.apply(transaction);
    const range = pastedContentRange(transaction);
    if (!range) throw new Error("nothing pasted");

    const found = pastedImageLinkRange(after.doc, range, url);
    expect(found).not.toBeNull();
    expect(found && after.doc.textBetween(found.from, found.to)).toBe(url);

    expect(pastedImageLinkRange(after.doc, range, "https://example.com/other.png")).toBeNull();
    // Outside the range the paste landed in, a link belongs to somebody else.
    expect(pastedImageLinkRange(after.doc, { from: 0, to: 5 }, url)).toBeNull();
  });
});

describe("naming an image the writer never named", () => {
  it("takes the last segment of the address", () => {
    expect(imageFilenameFromUrl("https://example.com/art/cover%20art.png?v=2")).toBe(
      "cover art.png",
    );
    expect(imageFilenameFromUrl("https://example.com/")).toBe("pasted image");
    expect(imageFilenameFromUrl("data:image/png;base64,AAAA")).toBe("pasted image");
  });

  it("refuses a name that is really a token, and keeps what it was", () => {
    const token = `${"e".repeat(180)}.png`;
    expect(imageFilenameFromUrl(`https://example.com/object-store/${token}`)).toBe(
      "pasted image.png",
    );
    expect(imageFilenameFromUrl(`https://example.com/object-store/${"e".repeat(180)}`)).toBe(
      "pasted image",
    );
  });
});
