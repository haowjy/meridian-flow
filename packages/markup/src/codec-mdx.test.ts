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
import { CodecParseError, mdxCodec } from "./index.js";

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
});
