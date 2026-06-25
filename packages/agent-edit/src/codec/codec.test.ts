import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";

import type { ComponentRegistry } from "../registry/component-registry.js";
import { createCodec, requiredBlockNamesForSchema } from "./create-codec.js";
import {
  markdownBlockCodecs,
  markdownCodec,
  markdownMarkCodecs,
  markdownRequiredBlockNames,
} from "./presets/markdown.js";
import { mdxBlockCodecs, mdxCodec, mdxRequiredBlockNames } from "./presets/mdx.js";
import { CodecParseError } from "./types.js";

const schema = buildDocumentSchema();
const components = {
  StatBlock: {
    name: "StatBlock",
    kind: "leaf",
    children: "none",
    props: {
      value: { type: "number", required: true },
      config: { type: "object" },
    },
  },
  Badge: {
    name: "Badge",
    kind: "leaf",
    children: "inline",
    props: {
      tone: { type: "string", required: true },
    },
  },
  Panel: {
    name: "Panel",
    kind: "container",
    children: "block",
    props: {
      title: { type: "string", required: true },
      meta: { type: "object" },
    },
  },
} satisfies ComponentRegistry;

const t = (text: string, marks?: readonly ReturnType<typeof schema.marks.strong.create>[]) =>
  schema.text(text, marks);
const m = (name: "strong" | "em" | "code" | "link", attrs?: Record<string, unknown>) =>
  schema.marks[name].create(attrs);
const paragraph = (...children: PMNode[]) => schema.node("paragraph", null, children);
const emptyParagraph = () => schema.node("paragraph");

function docFrom(blocks: PMNode[]): PMNode {
  return schema.node("doc", null, blocks);
}

function parsedDoc(codec: ReturnType<typeof mdxCodec>, input: string): PMNode {
  return docFrom(codec.parse(input).blocks);
}

function blocksOf(doc: PMNode): PMNode[] {
  return [...doc.content.content];
}

function sorted(names: readonly string[]): string[] {
  return [...names].sort();
}

function expectStable(codec: ReturnType<typeof mdxCodec>, input: string): void {
  const first = codec.parse(input).blocks;
  const serialized = codec.serialize(first);
  const second = codec.parse(serialized).blocks;
  expect(docFrom(second).toJSON()).toEqual(docFrom(first).toJSON());
  expect(codec.serialize(second)).toBe(serialized);
}

describe("codec presets", () => {
  it("registers every markdown node and mark codec", () => {
    const codec = markdownCodec({ schema });
    expect(codec.blocks.map((block) => block.name).sort()).toEqual(
      [...markdownRequiredBlockNames].sort(),
    );
    expect(codec.marks.map((mark) => mark.name).sort()).toEqual(["code", "em", "link", "strong"]);
  });

  it("registers every fiction-schema node handled by the MDX codec", () => {
    const codec = mdxCodec({ schema, components });
    const schemaRequiredBlocks = sorted(requiredBlockNamesForSchema(schema));
    expect(sorted(mdxRequiredBlockNames)).toEqual(schemaRequiredBlocks);
    expect(sorted(codec.blocks.map((block) => block.name))).toEqual(schemaRequiredBlocks);
    expect(codec.marks.map((mark) => mark.name).sort()).toEqual(["code", "em", "link", "strong"]);
  });

  it("fails creation when schema-derived block coverage is incomplete", () => {
    expect(() =>
      createCodec({
        schema,
        blocks: mdxBlockCodecs.filter((block) => block.name !== "figure"),
        marks: markdownMarkCodecs,
        requireSchemaBlockCoverage: true,
      }),
    ).toThrow('codec missing BlockCodec for schema node "figure"');
  });

  it("dispatches inline parse and serialize through registered mark codecs", () => {
    const customSerializeCodec = createCodec({
      schema,
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
      requiredBlockNames: markdownRequiredBlockNames,
    });
    expect(customSerializeCodec.serialize([paragraph(t("x", [m("strong")]))])).toBe(
      "[x](https://custom.example)\n",
    );

    const customParseCodec = createCodec({
      schema,
      blocks: markdownBlockCodecs,
      marks: markdownMarkCodecs.map((mark) =>
        mark.name === "strong" ? { ...mark, parse: () => null } : mark,
      ),
      requiredBlockNames: markdownRequiredBlockNames,
    });
    const parsed = customParseCodec.parse("**x**").blocks[0];
    expect(parsed?.firstChild?.marks).toHaveLength(0);
  });
});

describe("markdown codec round-trip corpus", () => {
  const codec = markdownCodec({ schema });

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

  it("stabilizes strong spans containing nested emphasis boundaries", () => {
    expectStable(codec, "Intro with **bold _em_** tail");
    expectStable(codec, "Intro with **bold *em*** tail");
  });

  it("stabilizes link labels containing closing brackets", () => {
    expectStable(codec, "[a\\]b](https://x.test)");
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
});

describe("mdx codec round-trip corpus", () => {
  const codec = mdxCodec({ schema, components });

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
      expect((error as Error).message).toContain("Could not parse expression with acorn");
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

describe("hash-prefixed block serialization", () => {
  it("uses hash|content for single-line blocks and hash| blocks for multiline blocks", () => {
    const codec = markdownCodec({ schema });
    expect(codec.serializeBlock(paragraph(t("lone")), "a1b2")).toBe("a1b2|lone");
    expect(
      codec.serializeBlock(
        schema.node("code_block", { language: "js" }, [t("console.log(1)\nconsole.log(2)")]),
        "c3d4",
      ),
    ).toBe("c3d4|\n```js\nconsole.log(1)\nconsole.log(2)\n```");
    expect(codec.serializeBlock(emptyParagraph(), "e5f6")).toBe("e5f6|");
  });

  it("serializes block bodies without hash prefixes for resolver matching", () => {
    const codec = markdownCodec({ schema });
    expect(
      codec.serializeBlockBodies([
        paragraph(t("lone")),
        schema.node("code_block", { language: "js" }, [t("console.log(1)\nconsole.log(2)")]),
        emptyParagraph(),
      ]),
    ).toEqual(["lone", "```js\nconsole.log(1)\nconsole.log(2)\n```", ""]);
  });
});
