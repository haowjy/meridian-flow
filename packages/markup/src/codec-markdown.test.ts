import { describe, expect, it } from "vitest";

import { unresolvedAssetPathResolver } from "./asset-path-resolver.js";
import {
  blocksOf,
  docFrom,
  emptyParagraph,
  expectStable,
  m,
  paragraph,
  parsedDoc,
  schema,
  t,
} from "./codec-test-support.js";
import { markdownCodec } from "./index.js";

describe("markdown codec round-trip corpus", () => {
  const codec = markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver });

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

  it.each([
    "a(b.md",
    "folder\\ notes.md",
    "a\\<b> c.md",
  ])("carries destination %j through the wire unchanged", (href) => {
    const doc = [paragraph(t("x", [m("link", { href, title: null })]))];
    const wire = codec.serialize(doc);
    expect(codec.parse(wire).blocks[0]?.toJSON()).toEqual(doc[0]?.toJSON());
    expectStable(codec, wire);
  });

  it("never lets a destination span lines", () => {
    const doc = [paragraph(t("x", [m("link", { href: "a\nb\r\nc.md", title: null })]))];
    const wire = codec.serialize(doc);
    expect(wire).toBe("[x](a%0Ab%0D%0Ac.md)\n");
    expect(codec.parse(wire).blocks[0]?.firstChild?.marks[0]?.attrs.href).toBe("a%0Ab%0D%0Ac.md");
  });

  it("parses mixed task list item checked attrs", () => {
    const doc = parsedDoc(codec, "- [x] a\n- plain\n- [ ] b\n");
    const list = doc.firstChild;
    expect(list?.type.name).toBe("bullet_list");
    expect(
      [...Array(list?.childCount ?? 0)].map((_, index) => list?.child(index).attrs.checked),
    ).toEqual([true, null, false]);
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

  it("keeps [[name]] literal text, never a link", () => {
    const input = "Before [[Chapter 213]], [[characters/Kael]], [[A|B]], and ![[Realm Map]].";
    const parsed = codec.parse(input).blocks;
    expect(parsed[0]?.textContent).toBe(input);
    expect(parsed[0]?.rangeHasMark(0, parsed[0].content.size, schema.marks.link)).toBe(false);
    expect(codec.parse(codec.serialize(parsed)).blocks[0]?.textContent).toBe(input);
    expectStable(codec, codec.serialize(parsed));
  });

  it("keeps HTAB-containing and enclosed destinations parseable", () => {
    for (const block of [
      paragraph(t("label", [m("link", { href: "A\tB.md", title: null })])),
      paragraph(schema.node("image", { src: "A\tB.png", alt: "alt", title: null })),
      paragraph(t("label", [m("link", { href: "A\tB.md", title: "t" })])),
      paragraph(schema.node("image", { src: "A\tB.png", alt: "alt", title: "t" })),
    ]) {
      const serialized = codec.serialize([block]);
      const reparsed = codec.parse(serialized).blocks;
      expect(docFrom(reparsed).toJSON()).toEqual(docFrom([block]).toJSON());
      expect(codec.serialize(reparsed)).toBe(serialized);
    }

    for (const input of [
      '[x](<A\tB.md>\n"title")',
      '![x](<A\tB.png>\n"title")',
      "[x](<A\tB.md>\n(title))",
      "[a\\](<b](<A\tB.md>)",
      "![a [b](<inner>)](<A\tB.png>)",
    ]) {
      expectStable(codec, input);
    }
  });

  it("does not rewrite link-looking text in code or raw HTML", () => {
    for (const input of ["`[label](<A B.md>)`", "```md\n[label](<A B.md>)\n```"]) {
      expect(codec.serialize(codec.parse(input).blocks)).toBe(`${input}\n`);
    }

    const indented = "    [label](<A B.md>)";
    const indentedParsed = codec.parse(indented).blocks;
    expect(
      docFrom(indentedParsed).rangeHasMark(
        0,
        docFrom(indentedParsed).content.size,
        schema.marks.link,
      ),
    ).toBe(false);
    expect(indentedParsed[0]?.textContent).toContain("[label](<A B.md>)");
    expectStable(codec, indented);

    for (const input of [
      '<span title="[label](A.md)">x</span>',
      "<!-- [label](A.md) -->",
      "<script>[label](A.md)</script>",
      "<div>\n[label](A.md)\n</div>",
    ]) {
      const htmlParsed = codec.parse(input).blocks;
      expect(
        docFrom(htmlParsed).rangeHasMark(0, docFrom(htmlParsed).content.size, schema.marks.link),
      ).toBe(false);
      expect(htmlParsed.map((block) => block.textContent).join("\n")).toContain("[label](A.md)");
      expectStable(codec, input);
    }
  });

  it("recognizes a link after a container implicitly closes its fence", () => {
    for (const input of [
      "> ```md\n> code\n\n[label](<A B.md>)",
      "- ```md\n  code\n\n[label](<A B.md>)",
    ]) {
      const fenceParsed = codec.parse(input).blocks;
      expect(fenceParsed.at(-1)?.firstChild?.marks[0]?.attrs.href).toBe("A B.md");
    }
  });

  it("carries empty auto-paired brackets through the wire unchanged", () => {
    // Auto-pairing in the editor writes real characters, so an empty pair the
    // writer opened and never filled is ordinary prose the wire has to carry.
    // The opener escapes so it cannot be read back as a link; the text the
    // writer sees comes back byte for byte.
    const prose = 'Brackets [] and [[]], parens (), and "quotes".';
    const wire = codec.serialize([paragraph(t(prose))]);

    expect(wire).toBe('Brackets \\[] and \\[\\[]], parens (), and "quotes".\n');
    expect(codec.parse(wire).blocks[0]?.textContent).toBe(prose);
    expect(codec.parse(wire).blocks[0]?.child(0).marks).toEqual([]);
    expectStable(codec, wire);
  });
});
