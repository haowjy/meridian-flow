import { describe, expect, it } from "vitest";

import { unresolvedAssetPathResolver } from "./asset-path-resolver.js";
import {
  blocksOf,
  docFrom,
  emptyParagraph,
  expectStable,
  paragraph,
  parsedDoc,
  schema,
  t,
} from "./codec-test-support.js";
import { markdownCodec } from "./index.js";

describe("markdown codec round-trip corpus", () => {
  const codec = markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver });

  it("stabilizes paragraphs, headings, nested marks, hard breaks, links, and images", () => {
    expectStable(
      codec,
      [
        "# The Ascension Trial",
        "",
        'Plain text, then **bold**, *italic*, `code()`, and [a link](https://example.com "Ex").',
        "",
        "nested ***bold-italic*** word.",
        "",
        "line one\\",
        "line two with ![a sword](img/sword.png) here.",
      ].join("\n"),
    );
  });

  // Tab is a key a writer presses in prose (the editor inserts one), so the
  // wire has to carry it. A tab in the middle of a line is literal; a LEADING
  // tab would parse back as an indented code block, so it goes out as a
  // character reference and comes back a tab.
  it("carries a tab through prose, wherever in the line it falls", () => {
    const withTabs = [
      paragraph(t("mid\tsentence tab")),
      paragraph(t("\tleading tab")),
      schema.node("heading", { level: 2 }, [t("\tindented heading")]),
    ];
    const wire = codec.serialize(withTabs);

    expect(wire).toBe("mid\tsentence tab\n\n&#x9;leading tab\n\n## &#x9;indented heading\n");
    expect(docFrom(codec.parse(wire).blocks).toJSON()).toEqual(docFrom(withTabs).toJSON());
    expectStable(codec, wire);
  });

  it("stabilizes strong spans containing nested emphasis boundaries", () => {
    expectStable(codec, "Intro with **bold _em_** tail");
    expectStable(codec, "Intro with **bold *em*** tail");
  });

  it("stabilizes link labels containing closing brackets", () => {
    expectStable(codec, "[a\\]b](https://x.test)");
  });

  it("parses mixed task list item checked attrs", () => {
    const doc = parsedDoc(codec, "- [x] a\n- plain\n- [ ] b\n");
    const list = doc.firstChild;
    expect(list?.type.name).toBe("bullet_list");
    expect(
      [...Array(list?.childCount ?? 0)].map((_, index) => list?.child(index).attrs.checked),
    ).toEqual([true, null, false]);
  });

  it("parses GFM table headers, body cells, and per-column alignment", () => {
    const doc = parsedDoc(
      codec,
      "| Left | Plain | Right |\n| :--- | ----- | ----: |\n| a | b | c |\n",
    );
    const table = doc.firstChild;
    expect(table?.type.name).toBe("table");

    const headerRow = table?.child(0);
    const bodyRow = table?.child(1);
    expect(
      [...Array(headerRow?.childCount ?? 0)].map((_, index) => headerRow?.child(index).type.name),
    ).toEqual(["table_header", "table_header", "table_header"]);
    expect(
      [...Array(bodyRow?.childCount ?? 0)].map((_, index) => bodyRow?.child(index).type.name),
    ).toEqual(["table_cell", "table_cell", "table_cell"]);
    expect(
      [...Array(headerRow?.childCount ?? 0)].map(
        (_, index) => headerRow?.child(index).attrs.alignment,
      ),
    ).toEqual(["left", null, "right"]);
    expect(
      [...Array(bodyRow?.childCount ?? 0)].map((_, index) => bodyRow?.child(index).attrs.alignment),
    ).toEqual(["left", null, "right"]);
  });

  it("parses strikethrough as strike marks", () => {
    const doc = parsedDoc(codec, "~~gone~~");
    const text = doc.firstChild?.firstChild;
    expect(text?.type.name).toBe("text");
    expect(text?.text).toBe("gone");
    expect(text?.marks.map((mark) => mark.type.name)).toEqual(["strike"]);
  });

  it("stabilizes GFM tables with alignment, empty cells, escaped pipes, and strike", () => {
    expectStable(
      codec,
      [
        "| Left | Center | Right |",
        "| :--- | :----: | ----: |",
        "| a |  | c |",
        "| has \\| pipe | ~~gone~~ | **bold** |",
      ].join("\n"),
    );
  });

  it("stabilizes lists, blockquotes, thematic breaks, and ordered-list starts", () => {
    expectStable(
      codec,
      [
        "> A quoted line.",
        "",
        "- first",
        "- second",
        "",
        "3. three",
        "4. four",
        "",
        "---",
        "",
        "After the break.",
      ].join("\n"),
    );
  });

  it("stabilizes code blocks with languages and backtick-heavy content", () => {
    expectStable(
      codec,
      [
        "```math",
        "E = mc^2",
        "```",
        "",
        "````stat",
        "```",
        "inside",
        "```",
        "````",
        "",
        "```",
        "plain code",
        "```",
      ].join("\n"),
    );
  });

  it("stabilizes empty paragraphs through the NBSP wire sentinel", () => {
    const doc = docFrom([paragraph(t("a")), emptyParagraph(), emptyParagraph(), paragraph(t("b"))]);
    const serialized = codec.serialize(blocksOf(doc));
    expect(serialized.split("\n").filter((line) => line === "\u00a0")).toHaveLength(2);
    expect(parsedDoc(codec, serialized).toJSON()).toEqual(doc.toJSON());
  });

  it("maps blank ingress to one empty paragraph", () => {
    expect(codec.parse(" \n\t").blocks).toHaveLength(1);
    expect(codec.parse(" \n\t").blocks[0]?.type.name).toBe("paragraph");
    expect(codec.parse(" \n\t").blocks[0]?.childCount).toBe(0);
  });

  it("serializes all-empty documents to an empty string", () => {
    expect(codec.serialize([emptyParagraph()])).toBe("");
    expect(codec.serialize([emptyParagraph(), emptyParagraph()])).toBe("");
    expect(codec.serializeBlocks([emptyParagraph()])).toEqual([""]);
  });
});
