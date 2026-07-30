import { describe, expect, it } from "vitest";

import { unresolvedAssetPathResolver } from "./asset-path-resolver.js";
import {
  components,
  docFrom,
  expectStable,
  m,
  paragraph,
  schema,
  sorted,
  t,
} from "./codec-test-support.js";
import {
  createMarkupCodec,
  markdownCodec,
  mdxCodec,
  requiredBlockNamesForSchema,
} from "./index.js";
import {
  markdownBlockCodecs,
  markdownMarkCodecs,
  markdownRequiredBlockNames,
} from "./markdown/index.js";
import { mdxBlockCodecs } from "./mdx/index.js";

describe("codec presets", () => {
  it.each([
    ["markdown", markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver })],
    ["mdx", mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver, components })],
  ])("round-trips first-class wikilinks through the %s preset", (_name, wikilinkCodec) => {
    const input =
      "Before [[Chapter 213]], [[characters/Kael]], [[AT&T]], [[chapter_one]], and [[#prologue]].";
    const parsed = wikilinkCodec.parse(input).blocks;

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
    expect(wikilinkCodec.serialize(parsed)).toBe(`${input}\n`);
    expect(docFrom(wikilinkCodec.parse(wikilinkCodec.serialize(parsed)).blocks).toJSON()).toEqual(
      docFrom(parsed).toJSON(),
    );
  });

  it.each([
    "[label]([[X]])",
    "[修炼 arc]([[第一章 雪夜]])",
  ])("round-trips a labeled wikilink href byte-exact: %s", (input) => {
    for (const wikilinkCodec of [
      markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
      mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver, components }),
    ]) {
      expect(wikilinkCodec.serialize(wikilinkCodec.parse(input).blocks)).toBe(`${input}\n`);
    }
  });

  it.each([
    ["image href", "![alt]([[X]])", "![alt]([[X]])"],
    ["image href with spaces", "![alt]([[Realm Map]])", "![alt]([[Realm Map]])"],
    ["link title", '[label]([[X]] "t")', '[label]([[X]] "t")'],
    ["escaped closing bracket in label", "[a\\]b]([[X]])", "[a\\]b]([[X]])"],
    ["nested brackets in label", "[a[b]c]([[X]])", "[a\\[b\\]c]([[X]])"],
    ["outer target whitespace", "[label]([[ X ]])", "[label]([[X]])"],
    ["invalid wikilink target", "[label]([[X|Y]])", "[label](\\[\\[X|Y]])"],
    ["Unicode-whitespace-only link target", "[label]([[ ]])", "[label](\\[\\[ ]])"],
    ["Unicode-whitespace-only image target", "![alt]([[ ]])", "![alt](\\[\\[ ]])"],
  ])("handles a wikilink resource with %s deterministically", (_case, input, expected) => {
    for (const wikilinkCodec of [
      markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
      mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver, components }),
    ]) {
      const parsed = wikilinkCodec.parse(input).blocks;
      const serialized = wikilinkCodec.serialize(parsed);
      expect(serialized).toBe(`${expected}\n`);
      expect(docFrom(wikilinkCodec.parse(serialized).blocks).toJSON()).toEqual(
        docFrom(parsed).toJSON(),
      );
    }
  });

  it.each([
    [
      "link with an internal tab",
      paragraph(t("label", [m("link", { href: "[[A\tB]]", title: null })])),
    ],
    [
      "image with an internal tab",
      paragraph(schema.node("image", { src: "[[A\tB]]", alt: "alt", title: null })),
    ],
    [
      "titled link with an internal tab",
      paragraph(t("label", [m("link", { href: "[[A\tB]]", title: "t" })])),
    ],
    [
      "titled image with an internal tab",
      paragraph(schema.node("image", { src: "[[A\tB]]", alt: "alt", title: "t" })),
    ],
    ["link with an outer tab", paragraph(t("X", [m("link", { href: "[[\tX]]", title: null })]))],
    [
      "image with an outer tab",
      paragraph(schema.node("image", { src: "[[\tX]]", alt: "alt", title: null })),
    ],
  ])("keeps an HTAB-containing wikilink-looking %s parseable", (_case, block) => {
    for (const wikilinkCodec of [
      markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
      mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver, components }),
    ]) {
      const serialized = wikilinkCodec.serialize([block]);
      const reparsed = wikilinkCodec.parse(serialized).blocks;
      expect(docFrom(reparsed).toJSON()).toEqual(docFrom([block]).toJSON());
      expect(wikilinkCodec.serialize(reparsed)).toBe(serialized);
    }
  });

  it.each([
    ["link", "[a\\](<b](<[[A\tB]]>)"],
    ["image", "![a\\](<b](<[[A\tB]]>)"],
    ["image with a nested-link alt", "![a [b](<inner>)](<[[A\tB]]>)"],
  ])("finds an enclosed %s destination after an escaped label delimiter", (_case, input) => {
    for (const wikilinkCodec of [
      markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
      mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver, components }),
    ]) {
      const parsed = wikilinkCodec.parse(input).blocks;
      const serialized = wikilinkCodec.serialize(parsed);
      const reparsed = wikilinkCodec.parse(serialized).blocks;
      expect(docFrom(reparsed).toJSON()).toEqual(docFrom(parsed).toJSON());
      expect(wikilinkCodec.serialize(reparsed)).toBe(serialized);
    }
  });

  it.each([
    ["link with a quoted title", '[x](<[[A\tB]]>\n"title")'],
    ["image with a quoted title", '![x](<[[A\tB]]>\n"title")'],
    ["link with a parenthesized title", "[x](<[[A\tB]]>\n(title))"],
    ["image with a parenthesized title", "![x](<[[A\tB]]>\n(title))"],
  ])("keeps a multiline enclosed %s parseable", (_case, input) => {
    const markdownParsed = markdownCodec({
      schema,
      assetPathResolver: unresolvedAssetPathResolver,
    }).parse(input).blocks;
    const wikilinkCodec = mdxCodec({
      schema,
      assetPathResolver: unresolvedAssetPathResolver,
      components,
    });
    const parsed = wikilinkCodec.parse(input).blocks;

    expect(docFrom(parsed).toJSON()).toEqual(docFrom(markdownParsed).toJSON());
    expectStable(wikilinkCodec, input);
  });

  it("keeps an MDX-incompatible nested-link label deterministic", () => {
    const wikilinkCodec = mdxCodec({
      schema,
      assetPathResolver: unresolvedAssetPathResolver,
      components,
    });
    const input = "[a[b](<c)](<[[A\tB]]>)";

    expectStable(wikilinkCodec, input);
  });

  it.each([
    "`[label]([[A B]])`",
    "```md\n[label]([[A B]])\n```",
  ])("does not rewrite labeled wikilink text inside code: %s", (input) => {
    for (const wikilinkCodec of [
      markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
      mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver, components }),
    ]) {
      expect(wikilinkCodec.serialize(wikilinkCodec.parse(input).blocks)).toBe(`${input}\n`);
    }
  });

  it("does not rewrite labeled-wikilink-looking text inside MDX props", () => {
    const wikilinkCodec = mdxCodec({
      schema,
      assetPathResolver: unresolvedAssetPathResolver,
      components,
    });
    const input = '<StatBlock value={7} config={{"note":"[label]([[A B]])"}} />';
    const parsed = wikilinkCodec.parse(input).blocks;

    expect(parsed[0]?.attrs.props).toEqual({
      value: 7,
      config: { note: "[label]([[A B]])" },
    });
    expect(docFrom(wikilinkCodec.parse(wikilinkCodec.serialize(parsed)).blocks).toJSON()).toEqual(
      docFrom(parsed).toJSON(),
    );
  });

  it.each([
    ["markdown", markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver })],
    ["mdx", mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver, components })],
  ])("keeps labeled-wikilink-looking raw HTML opaque in %s", (_name, wikilinkCodec) => {
    for (const input of [
      '<span title="[label]([[A B]])">x</span>',
      "<!-- [label]([[A B]]) -->",
      "<script>[label]([[A B]])</script>",
      "<div>\n[label]([[A B]])\n</div>",
      "> <div>\r> [label]([[A B]])\r> </div>",
      "- <div>\n\t[label]([[A B]])\n\t</div>",
    ]) {
      const parsed = wikilinkCodec.parse(input).blocks;
      expect(docFrom(parsed).rangeHasMark(0, docFrom(parsed).content.size, schema.marks.link)).toBe(
        false,
      );
      expect(parsed.map((block) => block.textContent).join("\n")).toContain("[label]([[A B]])");
      expectStable(wikilinkCodec, input);
    }
  });

  it("keeps labeled-wikilink-looking indented Markdown code opaque", () => {
    const wikilinkCodec = markdownCodec({
      schema,
      assetPathResolver: unresolvedAssetPathResolver,
    });
    const input = "    [label]([[A B]])";
    const parsed = wikilinkCodec.parse(input).blocks;
    expect(docFrom(parsed).rangeHasMark(0, docFrom(parsed).content.size, schema.marks.link)).toBe(
      false,
    );
    expect(parsed[0]?.textContent).toContain("[label]([[A B]])");
    expectStable(wikilinkCodec, input);
  });

  it.each([
    "> ```md\n> code\n\n[label]([[A B]])",
    "- ```md\n  code\n\n[label]([[A B]])",
  ])("recognizes a link after a container implicitly closes its fence", (input) => {
    for (const wikilinkCodec of [
      markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
      mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver, components }),
    ]) {
      const parsed = wikilinkCodec.parse(input).blocks;
      const link = parsed.at(-1)?.firstChild;
      expect(link?.marks[0]?.attrs.href).toBe("[[A B]]");
    }
  });

  it("keeps character references opaque in a labeled wikilink target", () => {
    for (const wikilinkCodec of [
      markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
      mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver, components }),
    ]) {
      const input = "[label]([[A&amp; B]])";
      const parsed = wikilinkCodec.parse(input).blocks;
      expect(parsed[0]?.firstChild?.marks[0]?.attrs.href).toBe("[[A&amp; B]]");
      expect(wikilinkCodec.serialize(parsed)).toBe(`${input}\n`);
    }
  });

  it("keeps character-reference-looking target text literal", () => {
    const wikilinkCodec = markdownCodec({
      schema,
      assetPathResolver: unresolvedAssetPathResolver,
    });
    const parsed = wikilinkCodec.parse("[[A&amp;B]]").blocks;

    expect(parsed[0]?.textContent).toBe("A&amp;B");
    expect(parsed[0]?.child(0).marks[0]?.attrs.href).toBe("[[A&amp;B]]");
    expect(wikilinkCodec.serialize(parsed)).toBe("[[A&amp;B]]\n");
  });

  it.each([
    "star*turn",
    "a<b",
    "a{b",
    " Chapter 214 ",
  ])("preserves markdown-sensitive wikilink target %j", (target) => {
    for (const wikilinkCodec of [
      markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
      mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver, components }),
    ]) {
      const wire = `[[${target}]]`;
      expect(wikilinkCodec.serialize(wikilinkCodec.parse(wire).blocks)).toBe(
        `[[${target.trim()}]]\n`,
      );
    }
  });

  it("keeps malformed, labeled, and code-contained bracket text literal", () => {
    const wikilinkCodec = mdxCodec({
      schema,
      assetPathResolver: unresolvedAssetPathResolver,
      components,
    });
    const input = [
      "Literal [[unfinished and [[target|label]] plus `[[inline code]]`.",
      "",
      "```md",
      "[[fenced code]]",
      "```",
    ].join("\n");

    const parsed = wikilinkCodec.parse(input).blocks;

    expect(parsed[0]?.textContent).toBe(
      "Literal [[unfinished and [[target|label]] plus [[inline code]].",
    );
    expect(parsed[0]?.rangeHasMark(0, parsed[0].content.size, schema.marks.link)).toBe(false);
    expect(parsed[1]?.textContent).toBe("[[fenced code]]");
    expect(wikilinkCodec.serialize(parsed)).not.toContain("[[target|label]]");
  });

  it.each([
    ["markdown", markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver })],
    ["mdx", mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver, components })],
  ])("carries empty auto-paired brackets through the %s preset unchanged", (_name, codec) => {
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

  it("registers every markdown node and mark codec", () => {
    expect(markdownBlockCodecs.map((block) => block.name).sort()).toEqual(
      [...markdownRequiredBlockNames].sort(),
    );
    expect(markdownMarkCodecs.map((mark) => mark.name).sort()).toEqual([
      "code",
      "em",
      "link",
      "strike",
      "strong",
    ]);
  });

  it("registers every fiction-schema node handled by the MDX codec", () => {
    mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver, components });
    const schemaRequiredBlocks = sorted(requiredBlockNamesForSchema(schema));
    expect(sorted(mdxBlockCodecs(components).map((block) => block.name))).toEqual(
      [...schemaRequiredBlocks, "layout"].sort(),
    );
    expect(markdownMarkCodecs.map((mark) => mark.name).sort()).toEqual([
      "code",
      "em",
      "link",
      "strike",
      "strong",
    ]);
  });

  it("fails creation when schema-derived block coverage is incomplete", () => {
    expect(() =>
      createMarkupCodec({ schema, assetPathResolver: unresolvedAssetPathResolver })
        .use({
          blocks: mdxBlockCodecs(components).filter((block) => block.name !== "figure"),
          marks: markdownMarkCodecs,
        })
        .build({ requireSchemaBlockCoverage: true }),
    ).toThrow('codec missing BlockCodec for schema node "figure"');
  });

  it("dispatches inline parse and serialize through registered mark codecs", () => {
    const customSerializeCodec = createMarkupCodec({
      schema,
      assetPathResolver: unresolvedAssetPathResolver,
    })
      .use({
        blocks: markdownBlockCodecs,
        marks: markdownMarkCodecs.map((mark) =>
          mark.name === "strong"
            ? {
                ...mark,
                serialize(text, _attrs, _ctx) {
                  return `[${text}](https://custom.example)`;
                },
              }
            : mark,
        ),
      })
      .build({ requiredBlockNames: markdownRequiredBlockNames });
    expect(customSerializeCodec.serialize([paragraph(t("x", [m("strong")]))])).toBe(
      "[x](https://custom.example)\n",
    );

    const customParseCodec = createMarkupCodec({
      schema,
      assetPathResolver: unresolvedAssetPathResolver,
    })
      .use({
        blocks: markdownBlockCodecs,
        marks: markdownMarkCodecs.map((mark) =>
          mark.name === "strong" ? { ...mark, parse: () => null } : mark,
        ),
      })
      .build({ requiredBlockNames: markdownRequiredBlockNames });
    const parsed = customParseCodec.parse("**x**").blocks[0];
    expect(parsed?.firstChild?.marks).toHaveLength(0);
  });
});
