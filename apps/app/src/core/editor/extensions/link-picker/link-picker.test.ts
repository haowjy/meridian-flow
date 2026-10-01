// @vitest-environment jsdom
/**
 * The `[[` picker's contract: which rows a query offers, where the create row
 * points, and the standard link a choice writes, spelled from the holder.
 */
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../../config";
import { insertDocumentLink } from "./document-link-insertion";
import {
  type LinkPickerCatalog,
  type LinkPickerDocument,
  linkPickerItems,
} from "./link-picker-items";

const doc = (
  documentId: string,
  uri: string,
  location: string,
  aliases: string[] = [],
): LinkPickerDocument => ({
  documentId,
  uri,
  location,
  aliases,
  title: (uri.split("/").at(-1) ?? uri).replace(/\.md$/, ""),
});

const chapterOne = doc("ch1", "manuscript://volume-1/chapter-1.md", "volume-1");
const chapterTwo = doc("ch2", "manuscript://volume-1/chapter-2.md", "volume-1");
const nextVolume = doc("v2c1", "manuscript://volume-2/chapter-1.md", "volume-2");
const linFeng = doc("lin", "kb://characters/Lin Feng.md", "Knowledge base/characters", [
  "Young Master Lin",
]);

const catalog = (holderUri: string | null): LinkPickerCatalog => ({
  label: "Link a document",
  documents: [chapterOne, chapterTwo, nextVolume, linFeng],
  holderUri,
});

describe("linkPickerItems", () => {
  const holder = catalog("manuscript://volume-2/chapter-1.md");

  it("tells same-named documents apart by where they live", () => {
    const rows = linkPickerItems(holder, "chapter-1");
    expect(
      rows.flatMap((row) => (row.kind === "document" ? [[row.name, row.location]] : [])),
    ).toEqual([
      ["chapter-1", "volume-1"],
      ["chapter-1", "volume-2"],
    ]);
  });

  it("matches aliases and paths as well as names", () => {
    expect(linkPickerItems(holder, "young master")[0]).toMatchObject({
      kind: "document",
      key: "lin",
      matchedAlias: "Young Master Lin",
    });
    expect(
      linkPickerItems(holder, "volume-2/ch").filter((row) => row.kind === "document"),
    ).toMatchObject([{ key: "v2c1" }]);
  });

  it("offers a create row in the holder's folder", () => {
    expect(linkPickerItems(holder, "Lin Mei").at(-1)).toEqual({
      kind: "create",
      key: "create",
      name: "Lin Mei",
      uri: "manuscript://volume-2/Lin Mei.md",
    });
  });

  it("targets the manuscript root from a document with no address yet", () => {
    expect(linkPickerItems(catalog(null), "Lin Mei").at(-1)).toMatchObject({
      kind: "create",
      uri: "manuscript://Lin Mei.md",
    });
  });

  it("drops the create row when a document is already at that address", () => {
    const rows = linkPickerItems(catalog("manuscript://volume-1/chapter-2.md"), "chapter-1");
    expect(rows.some((row) => row.kind === "create")).toBe(false);
  });

  it("offers nothing to create from a name that cannot be a filename", () => {
    expect(linkPickerItems(holder, "a/b").some((row) => row.kind === "create")).toBe(false);
    expect(linkPickerItems(holder, "Lin]")).toEqual([]);
  });
});

describe("insertDocumentLink", () => {
  let editor: Editor | null = null;
  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function insertedHref(holderUri: string | null, uri: string): string | null {
    editor = new Editor({
      extensions: createStandaloneEditorExtensions(),
      content: "<p>See [[</p>",
    });
    const end = editor.state.doc.content.size - 1;
    insertDocumentLink(editor, { from: end - 2, to: end }, { label: "Label", uri, holderUri });
    let href: string | null = null;
    editor.state.doc.descendants((node) => {
      const link = node.marks.find((mark) => mark.type.name === "link");
      if (link) href = link.attrs.href;
    });
    expect(editor.state.doc.textContent).toBe("See Label");
    return href;
  }

  it.each([
    ["manuscript://volume-1/chapter-1.md", "manuscript://volume-1/chapter-2.md", "chapter-2.md"],
    [
      "manuscript://volume-2/chapter-1.md",
      "manuscript://volume-1/chapter-1.md",
      "../volume-1/chapter-1.md",
    ],
    [
      "manuscript://volume-1/chapter-1.md",
      "kb://characters/Lin Feng.md",
      "kb://characters/Lin Feng.md",
    ],
    [null, "manuscript://volume-1/chapter-1.md", "manuscript://volume-1/chapter-1.md"],
    ["manuscript://volume-2/chapter-1.md", "manuscript://volume-2/Lin Mei.md", "Lin Mei.md"],
  ])("from %s, links %s as %s", (holderUri, uri, href) => {
    expect(insertedHref(holderUri, uri)).toBe(href);
  });
});
