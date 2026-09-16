import { describe, expect, it } from "vitest";

import { unresolvedAssetPathResolver } from "./asset-path-resolver.js";
import {
  blocksOf,
  components,
  docFrom,
  emptyParagraph,
  expectStable,
  firstParsedBlock,
  m,
  paragraph,
  parsedDoc,
  schema,
  t,
} from "./codec-test-support.js";
import { CodecParseError, formatWikilink, markdownCodec, mdxCodec } from "./index.js";

const codec = mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver, components });

describe("mdx prose and component round-trip corpus", () => {
  it("parses prose < and { as literal text without backslash corruption", () => {
    for (const sample of [
      "HP <50 and dropping fast.",
      "the {void} stirred beneath the city.",
      "Mana < 10 < 20 ranges, and a {} sigil.",
      "Tag-like <name> but not a real component.",
    ]) {
      const doc = parsedDoc(codec, sample);
      expect(doc.firstChild?.textContent).toBe(sample);
      expectStable(codec, sample);
    }
  });

  it("preserves < and { inside inline code spans", () => {
    const doc = parsedDoc(codec, "before ``a<b`c{d}`` after");
    const parts: Array<{ text: string; code: boolean }> = [];
    doc.firstChild?.forEach((child) => {
      if (child.type.name === "text") {
        parts.push({
          text: child.text ?? "",
          code: child.marks.some((mark) => mark.type.name === "code"),
        });
      }
    });
    expect(parts).toEqual([
      { text: "before ", code: false },
      { text: "a<b`c{d}", code: true },
      { text: " after", code: false },
    ]);
  });

  it("keeps raw URL prose as text, not link marks", () => {
    const doc = parsedDoc(codec, "visit https://example.com today");
    const firstText = doc.firstChild?.firstChild;
    expect(firstText?.type.name).toBe("text");
    expect(firstText?.marks).toHaveLength(0);
    expectStable(codec, "visit https://example.com today");
  });

  it("stabilizes Figure nodes with special characters in attrs", () => {
    expectStable(
      codec,
      '<Figure src="uploads://w1/map.png" alt="Realm map" label="fig-map" caption="The northern provinces &amp; beyond" />',
    );
  });

  it("round-trips a Figure with a multiline caption", () => {
    const figure = schema.node("figure", {
      src: "uploads://w1/map.png",
      alt: "Realm map",
      label: "fig-map",
      caption: "The northern provinces\nBeyond the pass",
    });
    const serialized = codec.serializeBlock(figure);

    expect(firstParsedBlock(codec, serialized).toJSON()).toEqual(figure.toJSON());
    expect(codec.serializeBlock(firstParsedBlock(codec, serialized))).toBe(serialized);
  });

  it("stabilizes JSX leaf components with nested JSON props", () => {
    expectStable(codec, '<StatBlock value={42} config={{"hp":10,"tags":["a","b"],"ok":true}} />');
  });

  it.each([
    {
      kind: "leaf",
      node: schema.node("jsx_leaf", { name: "Badge", props: { tone: "A & B\u0085 </span>" } }, [
        t("child"),
      ]),
    },
    {
      kind: "container",
      node: schema.node(
        "jsx_container",
        {
          name: "Panel",
          props: { title: "A & B\u0085 </span>", meta: { closing: "</span>" } },
        },
        [paragraph(t("child"))],
      ),
    },
  ])("round-trips lowercase tag-looking text in registered JSX $kind props", ({ node }) => {
    const serialized = codec.serializeBlock(node);

    expect(firstParsedBlock(codec, serialized).toJSON()).toEqual(node.toJSON());
    expect(codec.serializeBlock(firstParsedBlock(codec, serialized))).toBe(serialized);
  });

  it("stabilizes JSX leaf components with inline text children", () => {
    expectStable(codec, '<Badge tone="warn">caution **marked**</Badge>');
  });

  it("stabilizes JSX leaf inline children with nested marks", () => {
    expectStable(codec, '<Badge tone="warn">before **bold _em_** after</Badge>');
  });

  it("stabilizes JSX containers with block children and nested object props", () => {
    expectStable(
      codec,
      [
        '<Panel title="Stats" meta={{"nested":{"x":1},"list":[true,null]}}>',
        "",
        "Paragraph with **bold**.",
        "",
        "- item",
        "",
        "</Panel>",
      ].join("\n"),
    );
  });

  it("degrades unknown components to raw text paragraphs", () => {
    const blocks = codec.parse("<Unknown value={compute()} />").blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type.name).toBe("paragraph");
    expect(blocks[0]?.textContent).toBe("<Unknown value={compute()} />");
  });

  it("degrades non-JSON registered component expressions to raw text paragraphs", () => {
    const blocks = codec.parse("<StatBlock value={compute()} />").blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type.name).toBe("paragraph");
    expect(blocks[0]?.textContent).toBe("<StatBlock value={compute()} />");
  });

  it("degrades multiline invalid JSX to a stable raw code block", () => {
    const input = ["<Panel title={compute()}>", "", "para", "", "</Panel>"].join("\n");
    const blocks = codec.parse(input).blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type.name).toBe("code_block");
    expect(blocks[0]?.attrs.language).toBe("mdx");
    expect(blocks[0]?.textContent).toBe(input);
    expectStable(codec, input);
  });

  it("throws a typed codec error for syntactically invalid JSX expressions", () => {
    expect(() => codec.parse("<StatBlock value={{foo: }} />")).toThrow(CodecParseError);
    try {
      codec.parse("<StatBlock value={{foo: }} />");
    } catch (error) {
      expect(error).toBeInstanceOf(CodecParseError);
      expect(error).toMatchObject({
        line: 1,
        column: 25,
      });
      expect((error as Error).message).toContain("Could not parse markdown/MDX");
    }
  });

  it("round-trips the full surviving fiction node set", () => {
    const original = docFrom([
      schema.node("heading", { level: 1 }, [t("The Ascension Trial")]),
      paragraph(
        t("Plain text, then "),
        t("bold", [m("strong")]),
        t(", "),
        t("italic", [m("em")]),
        t(", "),
        t("code()", [m("code")]),
        t(", and a "),
        t("link", [m("link", { href: "https://example.com", title: "Ex" })]),
        t("."),
      ),
      paragraph(t("nested "), t("bold-italic", [m("strong"), m("em")]), t(" word.")),
      paragraph(t("line one"), schema.node("hard_break"), t("line two")),
      schema.node("blockquote", null, [paragraph(t("A quoted line."))]),
      schema.node("bullet_list", { tight: true }, [
        schema.node("list_item", null, [paragraph(t("first"))]),
        schema.node("list_item", null, [paragraph(t("second"))]),
      ]),
      schema.node("ordered_list", { order: 3, tight: false }, [
        schema.node("list_item", null, [paragraph(t("three"))]),
        schema.node("list_item", null, [paragraph(t("four"))]),
      ]),
      schema.node("code_block", { language: "math" }, [t("E = mc^2")]),
      paragraph(
        t("inline image "),
        schema.node("image", { src: "img/sword.png", alt: "a sword", title: null }),
        t(" here."),
      ),
      schema.node("figure", {
        src: "uploads://w1/map.png",
        alt: "Realm map",
        label: "fig-map",
        caption: "The northern provinces",
      }),
      schema.node("jsx_leaf", { name: "StatBlock", props: { value: 7, config: { hp: 10 } } }),
      schema.node("jsx_container", { name: "Panel", props: { title: "Stats" } }, [
        paragraph(t("inside")),
      ]),
      schema.node("horizontal_rule"),
      paragraph(t("After the break.")),
    ]);

    const serialized = codec.serialize(blocksOf(original));
    const back = parsedDoc(codec, serialized);
    expect(back.toJSON()).toEqual(original.toJSON());
  });

  it("emits the canonical representative MDX wire format", () => {
    const doc = docFrom([
      schema.node("heading", { level: 1 }, [t("Title")]),
      paragraph(t("bold bit", [m("strong")])),
      schema.node("bullet_list", { tight: true }, [
        schema.node("list_item", null, [paragraph(t("one"))]),
      ]),
      schema.node("ordered_list", { order: 3, tight: true }, [
        schema.node("list_item", null, [paragraph(t("three"))]),
      ]),
      schema.node("code_block", { language: "js" }, [t("console.log(1)")]),
      schema.node("figure", {
        src: "img.png",
        alt: "Alt",
        label: "fig-1",
        caption: "Cap",
      }),
      emptyParagraph(),
      paragraph(t("tail")),
    ]);

    expect(codec.serialize(blocksOf(doc))).toBe(
      '# Title\n\n**bold bit**\n\n- one\n\n3. three\n\n```js\nconsole.log(1)\n```\n\n<Figure src="img.png" alt="Alt" label="fig-1" caption="Cap" />\n\n\u00a0\n\ntail\n',
    );
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

    const markdown = markdownCodec({
      schema,
      assetPathResolver: unresolvedAssetPathResolver,
    });
    for (const input of [
      '[x](<[[A\tB]]>\n"title")',
      '![x](<[[A\tB]]>\n"title")',
      "[x](<[[A\tB]]>\n(title))",
      "![x](<[[A\tB]]>\n(title))",
    ]) {
      expect(docFrom(codec.parse(input).blocks).toJSON()).toEqual(
        docFrom(markdown.parse(input).blocks).toJSON(),
      );
      expectStable(codec, input);
    }

    expectStable(codec, "[a[b](<c)](<[[A\tB]]>)");
  });

  it("does not rewrite labeled-wikilink-looking text in code, props, or raw HTML", () => {
    for (const input of ["`[label]([[A B]])`", "```md\n[label]([[A B]])\n```"]) {
      expect(codec.serialize(codec.parse(input).blocks)).toBe(`${input}\n`);
    }

    const propsInput = '<StatBlock value={7} config={{"note":"[label]([[A B]])"}} />';
    const propsParsed = codec.parse(propsInput).blocks;
    expect(propsParsed[0]?.attrs.props).toEqual({
      value: 7,
      config: { note: "[label]([[A B]])" },
    });
    expect(docFrom(codec.parse(codec.serialize(propsParsed)).blocks).toJSON()).toEqual(
      docFrom(propsParsed).toJSON(),
    );

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

  it("keeps malformed and code-contained bracket text literal", () => {
    const input = [
      "Literal [[unfinished and [[target|]] plus `[[inline code]]`.",
      "",
      "```md",
      "[[fenced code]]",
      "```",
    ].join("\n");

    const parsed = codec.parse(input).blocks;

    expect(parsed[0]?.textContent).toBe(
      "Literal [[unfinished and [[target|]] plus [[inline code]].",
    );
    expect(parsed[0]?.rangeHasMark(0, parsed[0].content.size, schema.marks.link)).toBe(false);
    expect(parsed[1]?.textContent).toBe("[[fenced code]]");
    expect(codec.serialize(parsed)).not.toContain("[[target|]]");
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
