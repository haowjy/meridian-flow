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
import { formatWikilink, markdownCodec } from "./index.js";

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

  it("parses strikethrough as strike marks", () => {
    const doc = parsedDoc(codec, "~~gone~~");
    const text = doc.firstChild?.firstChild;
    expect(text?.type.name).toBe("text");
    expect(text?.text).toBe("gone");
    expect(text?.marks.map((mark) => mark.type.name)).toEqual(["strike"]);
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

  it.each([
    "Gate|Map.png",
    "Gate[Map].png",
    "folder\\notes.md",
    "uploads://@/Gate|Map.png",
  ])("round-trips reserved destination characters: %s", (target) => {
    const wire = formatWikilink(target, "My reference");
    const parsed = codec.parse(wire).blocks;
    expect(parsed[0]?.textContent).toBe("My reference");
    expect(parsed[0]?.firstChild?.marks[0]?.attrs.href).toBe(
      `[[${target.replace(/[\\[\]|]/g, "\\$&")}]]`,
    );
    expect(codec.serialize(parsed)).toBe(`${wire}\n`);
  });

  it("round-trips first-class, labeled, and display-text wikilinks", () => {
    const input =
      "Before [[Chapter 213]], [[characters/Kael]], [[AT&T]], [[chapter_one]], and [[#prologue]].";
    const parsed = codec.parse(input).blocks;
    expect(parsed[0]?.toJSON()).toEqual(
      paragraph(
        t("Before "),
        t("Chapter 213", [m("link", { href: "[[Chapter 213]]", title: null })]),
        t(", "),
        t("characters/Kael", [m("link", { href: "[[characters/Kael]]", title: null })]),
        t(", "),
        t("AT&T", [m("link", { href: "[[AT&T]]", title: null })]),
        t(", "),
        t("chapter_one", [m("link", { href: "[[chapter_one]]", title: null })]),
        t(", and "),
        t("#prologue", [m("link", { href: "[[#prologue]]", title: null })]),
        t("."),
      ).toJSON(),
    );
    expect(codec.serialize(parsed)).toBe(`${input}\n`);
    expect(docFrom(codec.parse(codec.serialize(parsed)).blocks).toJSON()).toEqual(
      docFrom(parsed).toJSON(),
    );

    for (const wire of ["[**bold** and plain]([[Guide]])", '[label]([[Guide]] "tooltip")']) {
      const blocks = codec.parse(wire).blocks;
      expect(codec.parse(codec.serialize(blocks)).blocks.map((node) => node.toJSON())).toEqual(
        blocks.map((node) => node.toJSON()),
      );
    }

    for (const label of [
      "Walkthrough",
      "a\tb",
      "修炼 arc",
      "a]b|c\\d",
      "A&amp;B",
      "**literal**",
      " <b>{text} ",
    ]) {
      const doc = [paragraph(t(label, [m("link", { href: "[[guide.md]]", title: null })]))];
      const wire = `[[guide.md|${label.replace(/[\\\]|]/g, "\\$&")}]]\n`;
      expect(codec.serialize(doc)).toBe(wire);
      expect(codec.parse(wire).blocks[0]?.toJSON()).toEqual(doc[0]?.toJSON());
    }

    for (const [labeled, expected] of [
      ["[label]([[X]])", "[[X|label]]"],
      ["[修炼 arc]([[第一章 雪夜]])", "[[第一章 雪夜|修炼 arc]]"],
    ] as const) {
      expect(codec.serialize(codec.parse(labeled).blocks)).toBe(`${expected}\n`);
    }

    for (const target of ["star*turn", "a<b", "a{b", " Chapter 214 "]) {
      expect(codec.serialize(codec.parse(`[[${target}]]`).blocks)).toBe(`[[${target.trim()}]]\n`);
    }

    const ampLabeled = codec.parse("[label]([[A&amp; B]])").blocks;
    expect(ampLabeled[0]?.firstChild?.marks[0]?.attrs.href).toBe("[[A&amp; B]]");
    expect(codec.serialize(ampLabeled)).toBe("[[A&amp; B|label]]\n");

    const ampTarget = codec.parse("[[A&amp;B]]").blocks;
    expect(ampTarget[0]?.textContent).toBe("A&amp;B");
    expect(ampTarget[0]?.child(0).marks[0]?.attrs.href).toBe("[[A&amp;B]]");
    expect(codec.serialize(ampTarget)).toBe("[[A&amp;B]]\n");
  });

  it("handles wikilink resources deterministically", () => {
    for (const [input, expected] of [
      ["![alt]([[X]])", "![alt]([[X]])"],
      ["![alt]([[Realm Map]])", "![alt]([[Realm Map]])"],
      ['[label]([[X]] "t")', '[label]([[X]] "t")'],
      ["[a\\]b]([[X]])", "[[X|a\\]b]]"],
      ["[a[b]c]([[X]])", "[[X|a[b\\]c]]"],
      ["[label]([[ X ]])", "[[X|label]]"],
      ["[label]([[X|Y]])", "[label](\\[\\[X|Y]])"],
      ["[label]([[\u00a0]])", "[label](\\[\\[\u00a0]])"],
      ["![alt]([[\u00a0]])", "![alt](\\[\\[\u00a0]])"],
    ] as const) {
      const resourceParsed = codec.parse(input).blocks;
      const serialized = codec.serialize(resourceParsed);
      expect(serialized).toBe(`${expected}\n`);
      expect(docFrom(codec.parse(serialized).blocks).toJSON()).toEqual(
        docFrom(resourceParsed).toJSON(),
      );
    }
  });

  it("keeps HTAB-containing and enclosed wikilink destinations parseable", () => {
    for (const block of [
      paragraph(t("label", [m("link", { href: "[[A\tB]]", title: null })])),
      paragraph(schema.node("image", { src: "[[A\tB]]", alt: "alt", title: null })),
      paragraph(t("label", [m("link", { href: "[[A\tB]]", title: "t" })])),
      paragraph(schema.node("image", { src: "[[A\tB]]", alt: "alt", title: "t" })),
      paragraph(t("X", [m("link", { href: "[[\tX]]", title: null })])),
      paragraph(schema.node("image", { src: "[[\tX]]", alt: "alt", title: null })),
    ]) {
      const serialized = codec.serialize([block]);
      const reparsed = codec.parse(serialized).blocks;
      expect(docFrom(reparsed).toJSON()).toEqual(docFrom([block]).toJSON());
      expect(codec.serialize(reparsed)).toBe(serialized);
    }

    for (const input of [
      "[a\\](<b](<[[A\tB]]>)",
      "![a\\](<b](<[[A\tB]]>)",
      "![a [b](<inner>)](<[[A\tB]]>)",
    ]) {
      const enclosedParsed = codec.parse(input).blocks;
      const serialized = codec.serialize(enclosedParsed);
      const reparsed = codec.parse(serialized).blocks;
      expect(docFrom(reparsed).toJSON()).toEqual(docFrom(enclosedParsed).toJSON());
      expect(codec.serialize(reparsed)).toBe(serialized);
    }

    for (const input of [
      '[x](<[[A\tB]]>\n"title")',
      '![x](<[[A\tB]]>\n"title")',
      "[x](<[[A\tB]]>\n(title))",
      "![x](<[[A\tB]]>\n(title))",
    ]) {
      expectStable(codec, input);
    }
  });

  it("does not rewrite labeled-wikilink-looking text in code or raw HTML", () => {
    for (const input of ["`[label]([[A B]])`", "```md\n[label]([[A B]])\n```"]) {
      expect(codec.serialize(codec.parse(input).blocks)).toBe(`${input}\n`);
    }

    const indented = "    [label]([[A B]])";
    const indentedParsed = codec.parse(indented).blocks;
    expect(
      docFrom(indentedParsed).rangeHasMark(
        0,
        docFrom(indentedParsed).content.size,
        schema.marks.link,
      ),
    ).toBe(false);
    expect(indentedParsed[0]?.textContent).toContain("[label]([[A B]])");
    expectStable(codec, indented);

    for (const input of [
      '<span title="[label]([[A B]])">x</span>',
      "<!-- [label]([[A B]]) -->",
      "<script>[label]([[A B]])</script>",
      "<div>\n[label]([[A B]])\n</div>",
      "> <div>\r> [label]([[A B]])\r> </div>",
      "- <div>\n\t[label]([[A B]])\n\t</div>",
    ]) {
      const htmlParsed = codec.parse(input).blocks;
      expect(
        docFrom(htmlParsed).rangeHasMark(0, docFrom(htmlParsed).content.size, schema.marks.link),
      ).toBe(false);
      expect(htmlParsed.map((block) => block.textContent).join("\n")).toContain("[label]([[A B]])");
      expectStable(codec, input);
    }
  });

  it("recognizes a link after a container implicitly closes its fence", () => {
    for (const input of [
      "> ```md\n> code\n\n[label]([[A B]])",
      "- ```md\n  code\n\n[label]([[A B]])",
    ]) {
      const fenceParsed = codec.parse(input).blocks;
      expect(fenceParsed.at(-1)?.firstChild?.marks[0]?.attrs.href).toBe("[[A B]]");
    }
  });

  it("carries empty auto-paired brackets through the wire unchanged", () => {
    // Auto-pairing in the editor writes real characters, so an empty pair the
    // writer opened and never filled is ordinary prose the wire has to carry.
    // The opener escapes so it cannot be read back as a link or a wikilink;
    // the text the writer sees comes back byte for byte.
    const prose = 'Brackets [] and [[]], parens (), and "quotes".';
    const wire = codec.serialize([paragraph(t(prose))]);

    expect(wire).toBe('Brackets \\[] and \\[\\[]], parens (), and "quotes".\n');
    expect(codec.parse(wire).blocks[0]?.textContent).toBe(prose);
    expect(codec.parse(wire).blocks[0]?.child(0).marks).toEqual([]);
    expectStable(codec, wire);
  });
});
