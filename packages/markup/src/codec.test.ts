import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { createAssetPathResolver, unresolvedAssetPathResolver } from "./asset-path-resolver.js";

import {
  CodecParseError,
  type ComponentRegistry,
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
import { mdxBlockCodecs, mdxRequiredBlockNames } from "./mdx/index.js";

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
const m = (name: "strong" | "em" | "code" | "link" | "strike", attrs?: Record<string, unknown>) =>
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

function firstParsedBlock(codec: ReturnType<typeof mdxCodec>, input: string): PMNode {
  const block = codec.parse(input).blocks[0];
  if (!block) throw new Error("expected one parsed block");
  return block;
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
    expect(sorted(mdxRequiredBlockNames)).toEqual(schemaRequiredBlocks);
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

describe("asset path resolution", () => {
  const assetPathResolver = createAssetPathResolver([["asset-1", "assets/map.png"]]);
  const codec = markdownCodec({ schema, assetPathResolver });

  it("stores stable refs internally and emits project-relative paths", () => {
    const parsed = codec.parse("![World map](assets/map.png)").blocks[0];
    if (!parsed) throw new Error("expected parsed image paragraph");
    expect(parsed?.firstChild?.attrs.src).toBe("asset:asset-1");
    expect(codec.serialize([parsed])).toBe("![World map](assets/map.png)\n");
  });

  it("leaves external and unknown paths literal", () => {
    for (const src of ["https://example.com/map.png", "assets/missing.png"]) {
      expect(codec.parse(`![](${src})`).blocks[0]?.firstChild?.attrs.src).toBe(src);
    }
  });
});

describe("mdx codec round-trip corpus", () => {
  const codec = mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver, components });

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

  it("keeps unstyled alignable blocks in byte-identical plain markdown", () => {
    const plain = "Plain prose.\n\n## Heading\n\n| A | B |\n| - | - |\n| 1 | 2 |\n";
    expect(codec.serialize(codec.parse(plain).blocks)).toBe(plain);
    expect(codec.serialize(codec.parse(plain).blocks)).not.toContain("<Layout");
  });

  it("emits canonical Layout wrappers for styled paragraphs, headings, and tables", () => {
    const table = firstParsedBlock(
      codec,
      "| Stat | Description | Value |\n| - | - | -: |\n| STR | Raw power | 15 |",
    );
    const rows: PMNode[] = [];
    table.forEach((row) => {
      const cells: PMNode[] = [];
      row.forEach((cell, _offset, index) => {
        const width = [120, null, 80][index];
        cells.push(
          cell.type.create({ ...cell.attrs, colwidth: width ? [width] : null }, cell.content),
        );
      });
      rows.push(row.type.create(row.attrs, cells));
    });
    const styledTable = table.type.create({ align: "center" }, rows);

    expect(
      codec.serializeBlock(
        schema.node("paragraph", { align: "center" }, [t("The sword remembers.")]),
      ),
    ).toBe('<Layout align="center">\n  The sword remembers.\n</Layout>');
    expect(
      codec.serializeBlock(schema.node("heading", { level: 2, align: "right" }, [t("Dateline")])),
    ).toBe('<Layout align="right">\n  ## Dateline\n</Layout>');
    expect(codec.serializeBlock(styledTable)).toBe(
      '<Layout align="center" widths="120,,80">\n  | Stat | Description | Value |\n  | ---- | ----------- | ----: |\n  | STR  | Raw power   |    15 |\n</Layout>',
    );
  });

  it("reaches a parse-serialize-parse fixpoint for every Layout form", () => {
    for (const input of [
      '<Layout align="center">\n  The sword remembers.\n</Layout>',
      '<Layout align="right">\n  ## Dateline\n</Layout>',
      '<Layout align="center" widths="120,,80">\n  | Stat | Description | Value |\n  | ---- | ----------- | ----: |\n  | STR  | Raw power   |    15 |\n</Layout>',
    ]) {
      expectStable(codec, input);
    }
  });

  it("round-trips styled blocks through nested block serializers", () => {
    const originals = [
      schema.node("blockquote", null, [
        schema.node("paragraph", { align: "right" }, [t("inside quote")]),
      ]),
      schema.node("bullet_list", { tight: true }, [
        schema.node("list_item", null, [
          schema.node("paragraph", { align: "center" }, [t("inside list")]),
        ]),
      ]),
    ];

    for (const original of originals) {
      const serialized = codec.serializeBlock(original);
      expect(serialized).toContain("Layout align=");
      expect(firstParsedBlock(codec, serialized).toJSON()).toEqual(original.toJSON());
    }
  });

  it("rejects nested Layout and unknown JSX children as one invalid wrapper", () => {
    for (const input of [
      '<Layout align="center">\n  <Layout align="right">\n    prose\n  </Layout>\n</Layout>',
      '<Layout align="center">\n  <Unknown />\n</Layout>',
    ]) {
      const invalid = firstParsedBlock(codec, input);
      expect(invalid.type.name === "paragraph" || invalid.type.name === "code_block").toBe(true);
      expect(invalid.textContent).toContain('<Layout align="center">');
      expect(invalid.attrs.align ?? null).toBeNull();
    }
  });

  it("validates widths and normalizes them onto every cell in each column", () => {
    const input =
      '<Layout widths="120,,80">\n  | A | B | C |\n  | - | - | - |\n  | 1 | 2 | 3 |\n</Layout>';
    const table = firstParsedBlock(codec, input);
    expect(table.type.name).toBe("table");
    table.forEach((row) => {
      expect([...Array(row.childCount)].map((_, index) => row.child(index).attrs.colwidth)).toEqual(
        [[120], null, [80]],
      );
    });
    expect(codec.serializeBlock(table)).toContain('widths="120,,80"');

    for (const widths of ["120,nope,80", "120,80", "0,,80", ",,"]) {
      expect(
        codec.parse(`<Layout widths="${widths}">\n  | A | B | C |\n  | - | - | - |\n</Layout>`)
          .blocks[0]?.type.name,
      ).not.toBe("table");
    }
    const nonTable = codec.parse('<Layout widths="120">\n  prose\n</Layout>').blocks[0];
    expect(nonTable?.textContent).toContain("<Layout");
    expect(nonTable?.attrs.align).toBeNull();
  });

  it("throws rather than silently serializing table spans", () => {
    const table = firstParsedBlock(codec, "| A | B |\n| - | - |\n| 1 | 2 |");
    const firstRow = table.child(0);
    const firstCell = firstRow.child(0);
    const spanned = firstCell.type.create({ ...firstCell.attrs, colspan: 2 }, firstCell.content);
    const changedRow = firstRow.type.create(firstRow.attrs, [spanned, firstRow.child(1)]);
    const changedTable = table.type.create(table.attrs, [changedRow, table.child(1)]);
    expect(() => codec.serializeBlock(changedTable)).toThrow(
      "table cell spans are not representable",
    );

    const zeroSpan = firstCell.type.create({ ...firstCell.attrs, colspan: 0 }, firstCell.content);
    const zeroRow = firstRow.type.create(firstRow.attrs, [zeroSpan, firstRow.child(1)]);
    const zeroTable = table.type.create(table.attrs, [zeroRow, table.child(1)]);
    expect(() => codec.serializeBlock(zeroTable)).toThrow("table cell spans are not representable");
  });

  it("throws rather than silently dropping malformed column widths", () => {
    const table = firstParsedBlock(codec, "| A |\n| - |\n| 1 |");
    const firstRow = table.child(0);
    const firstCell = firstRow.child(0);
    const malformedCell = firstCell.type.create(
      { ...firstCell.attrs, colwidth: [0] },
      firstCell.content,
    );
    const malformedRow = firstRow.type.create(firstRow.attrs, [malformedCell]);
    const malformedTable = table.type.create(table.attrs, [malformedRow, table.child(1)]);
    expect(() => codec.serializeBlock(malformedTable)).toThrow(
      "table cell colwidth must be null or one positive integer",
    );
  });

  it("rejects the align-left ghost state", () => {
    const ghost = schema.nodes.paragraph.create({ align: "left" }, t("prose"));
    expect(() => codec.serializeBlock(ghost)).toThrow('invalid Layout align value "left"');
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
