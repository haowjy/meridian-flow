import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";

import { unresolvedAssetPathResolver } from "./asset-path-resolver.js";
import {
  components,
  expectStable,
  firstParsedBlock,
  m,
  paragraph,
  schema,
  t,
} from "./codec-test-support.js";
import { markdownCodec, mdxCodec } from "./index.js";
import {
  canonicalizeGfmTableHardBreaks,
  normalizeGfmTableHardBreaks,
} from "./markdown/blocks/table.js";

const codec = mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver, components });

describe("tables and Layout round-trip corpus", () => {
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

  it("carries a resized column across a merged cell, which spans two grid slots", () => {
    // What the editor produces: merge a header row, then drag the boundary of
    // its second grid column. prosemirror-tables sizes `colwidth` to the cell's
    // colspan and leaves the untouched slots at zero.
    const cell = (type: "table_header" | "table_cell", text: string, attrs = {}) =>
      schema.node(type, attrs, [paragraph(t(text))]);
    const table = schema.node("table", null, [
      schema.node("table_row", null, [
        cell("table_header", "Status", { colspan: 2, colwidth: [0, 266] }),
      ]),
      // The resize wrote the new width into every row of that grid column.
      schema.node("table_row", null, [
        cell("table_cell", "Class"),
        cell("table_cell", "Warden", { colwidth: [266] }),
      ]),
    ]);

    const serialized = codec.serializeBlock(table);
    expect(serialized).toContain('widths=",266"');
    expect(firstParsedBlock(codec, serialized).toJSON()).toEqual(table.toJSON());
    expectStable(codec, serialized);
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

  it("escalates table spans to canonical HTML and parses them back", () => {
    const table = firstParsedBlock(codec, "| A | B |\n| - | - |\n| 1 | 2 |");
    const firstRow = table.child(0);
    const firstCell = firstRow.child(0);
    const spanned = firstCell.type.create({ ...firstCell.attrs, colspan: 2 }, firstCell.content);
    const changedRow = firstRow.type.create(firstRow.attrs, [spanned]);
    const changedTable = table.type.create(table.attrs, [changedRow, table.child(1)]);
    const html = [
      "<table>",
      "  <thead>",
      "    <tr>",
      '      <th colspan="2">A</th>',
      "    </tr>",
      "  </thead>",
      "  <tbody>",
      "    <tr>",
      "      <td>1</td>",
      "      <td>2</td>",
      "    </tr>",
      "  </tbody>",
      "</table>",
    ].join("\n");

    expect(codec.serializeBlock(changedTable)).toBe(html);
    expect(codec.serializeBlock(firstParsedBlock(codec, html))).toBe(html);
    expect(firstParsedBlock(codec, html).child(0).child(0).attrs.colspan).toBe(2);
  });

  it("escalates literal multi-line cell text to canonical HTML", () => {
    const table = firstParsedBlock(codec, "| A |\n| - |\n| one |");
    const bodyRow = table.child(1);
    const bodyCell = bodyRow.child(0);
    const multiLineCell = bodyCell.type.create(bodyCell.attrs, [paragraph(t("one\nand two"))]);
    const changedTable = table.type.create(table.attrs, [
      table.child(0),
      bodyRow.type.create(bodyRow.attrs, [multiLineCell]),
    ]);
    const html = [
      "<table>",
      "  <thead>",
      "    <tr>",
      "      <th>A</th>",
      "    </tr>",
      "  </thead>",
      "  <tbody>",
      "    <tr>",
      "      <td>one&#10;and two</td>",
      "    </tr>",
      "  </tbody>",
      "</table>",
    ].join("\n");

    expect(codec.serializeBlock(changedTable)).toBe(html);
    expect(firstParsedBlock(codec, html).toJSON()).toEqual(changedTable.toJSON());
    expect(codec.serializeBlock(firstParsedBlock(codec, html))).toBe(html);
  });

  it("round-trips headerless HTML tables with per-column alignment", () => {
    const html = [
      "<table>",
      "  <tbody>",
      "    <tr>",
      '      <td align="left">Skill</td>',
      '      <td align="right">Rank</td>',
      "    </tr>",
      "    <tr>",
      '      <td align="left">Iron Body</td>',
      '      <td align="right">7</td>',
      "    </tr>",
      "  </tbody>",
      "</table>",
    ].join("\n");
    const table = firstParsedBlock(codec, html);

    expect(table.child(0).child(0).type.name).toBe("table_cell");
    expect(table.child(0).child(1).attrs.alignment).toBe("right");
    expect(codec.serializeBlock(table)).toBe(html);
    expect(codec.serializeBlock(firstParsedBlock(codec, html))).toBe(html);
  });

  it("preserves inline formatting on the HTML table path", () => {
    const html = [
      "<table>",
      "  <tbody>",
      "    <tr>",
      '      <td><strong>Iron</strong> <a href="chapter-7.md">Body</a><br />Rank 7</td>',
      "    </tr>",
      "  </tbody>",
      "</table>",
    ].join("\n");
    const table = firstParsedBlock(codec, html);
    const paragraph = table.child(0).child(0).child(0);

    expect(paragraph.child(0).marks[0]?.type.name).toBe("strong");
    expect(paragraph.child(2).marks[0]?.type.name).toBe("link");
    expect(paragraph.child(3).type.name).toBe("hard_break");
    expect(codec.serializeBlock(table)).toBe(html);
  });

  it("entity-escapes MDX-significant braces on the HTML table path", () => {
    const html = [
      "<table>",
      "  <tbody>",
      "    <tr>",
      "      <td>a &#123; brace and <code>&#125;</code></td>",
      "    </tr>",
      "  </tbody>",
      "</table>",
    ].join("\n");
    const table = firstParsedBlock(codec, html);

    expect(table.textContent).toBe("a { brace and }");
    expect(codec.serializeBlock(table)).toBe(html);
    expect(codec.serializeBlock(firstParsedBlock(codec, html))).toBe(html);
  });

  it("round-trips Layout around an HTML-spelled table", () => {
    const html = [
      "<table>",
      "  <tbody>",
      "    <tr>",
      '      <td colspan="2">Section</td>',
      "    </tr>",
      "  </tbody>",
      "</table>",
    ].join("\n");
    const table = firstParsedBlock(codec, html);
    const aligned = table.type.create({ align: "center" }, table.content);
    const wrapped = [
      '<Layout align="center">',
      ...html.split("\n").map((line) => `  ${line}`),
      "</Layout>",
    ].join("\n");

    expect(codec.serializeBlock(aligned)).toBe(wrapped);
    expect(firstParsedBlock(codec, wrapped).toJSON()).toEqual(aligned.toJSON());
    expect(codec.serializeBlock(firstParsedBlock(codec, wrapped))).toBe(wrapped);
  });

  it("keeps aligned GFM tables in pipes", () => {
    const gfm = "| Skill     | Rank |\n| :-------- | ---: |\n| Iron Body |    7 |\n";
    expect(codec.serialize(codec.parse(gfm).blocks)).toBe(gfm);
    expect(codec.serialize(codec.parse(gfm).blocks)).not.toContain("<table>");
  });

  it("round-trips hard breaks inside pipe cells as backslash-newline", () => {
    const table = firstParsedBlock(codec, "| Detail |\n| - |\n| one |");
    const bodyRow = table.child(1);
    const bodyCell = bodyRow.child(0);
    const breakCell = bodyCell.type.create(bodyCell.attrs, [
      paragraph(t("one"), schema.node("hard_break"), t("two")),
    ]);
    const changedTable = table.type.create(table.attrs, [
      table.child(0),
      bodyRow.type.create(bodyRow.attrs, [breakCell]),
    ]);
    const gfm = "| Detail    |\n| --------- |\n| one\\\ntwo |\n";

    expect(codec.serializeBlock(changedTable)).toBe(gfm.trimEnd());
    expect(firstParsedBlock(codec, gfm).toJSON()).toEqual(changedTable.toJSON());
    expect(codec.serializeBlock(firstParsedBlock(codec, gfm))).toBe(gfm.trimEnd());
  });

  it("does not confuse literal br syntax with a pipe-cell hard break", () => {
    const input = "| Value           |\n| --------------- |\n| literal \\<br/> |\n";
    const first = firstParsedBlock(codec, input);
    const serialized = codec.serializeBlock(first);

    expect(serialized).not.toContain("\\\n");
    expect(firstParsedBlock(codec, serialized).toJSON()).toEqual(first.toJSON());
  });

  it("does not normalize table-looking hard breaks inside code fences", () => {
    const input = ["```md", "| H |", "| - |", "| a\\", "b |", "```"].join("\n");
    const block = firstParsedBlock(codec, input);

    expect(block.type.name).toBe("code_block");
    expect(block.textContent).toBe(["| H |", "| - |", "| a\\", "b |"].join("\n"));
    expect(codec.serializeBlock(block)).toBe(input);
  });

  it("does not canonicalize literal br syntax inside code fences", () => {
    const input = ["```md", "| H |", "| - |", "| a<br />b |", "```"].join("\n");
    const nested = [
      "- outer",
      "  - inner",
      "    ```md",
      "    | H |",
      "    | - |",
      "    | a<br />b |",
      "    ```",
    ].join("\n");
    const padded = [
      "-   outer",
      "",
      "      ```md",
      "      | H |",
      "      | - |",
      "      | a<br />b |",
      "      ```",
    ].join("\n");
    const tabPadded = [
      "-\touter",
      "",
      "\t  ```md",
      "\t  | H |",
      "\t  | - |",
      "\t  | a<br />b |",
      "\t  ```",
    ].join("\n");

    for (const activeCodec of [
      markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
      codec,
    ]) {
      const block = firstParsedBlock(activeCodec, input);
      expect(block.type.name).toBe("code_block");
      expect(activeCodec.serializeBlock(block)).toBe(input);

      for (const nestedInput of [nested, padded, tabPadded]) {
        const nestedBlock = firstParsedBlock(activeCodec, nestedInput);
        const nestedCode: PMNode[] = [];
        nestedBlock.descendants((node) => {
          if (node.type.name === "code_block") nestedCode.push(node);
        });
        expect(nestedCode[0]?.textContent).toContain("a<br />b");
        const serializedNested = activeCodec.serializeBlock(nestedBlock);
        expect(serializedNested).not.toContain("\\<br");
        expect(firstParsedBlock(activeCodec, serializedNested).toJSON()).toEqual(
          nestedBlock.toJSON(),
        );
      }
    }
    expect(canonicalizeGfmTableHardBreaks(nested)).toBe(nested);
  });

  it("does not normalize table-looking text inside indented code", () => {
    for (const indent of ["    ", "\t"]) {
      const input = [`${indent}| H |`, `${indent}| - |`, `${indent}| a\\`, `${indent}b |`].join(
        "\n",
      );

      expect(normalizeGfmTableHardBreaks(input)).toBe(input);
    }
  });

  it("does not normalize table-looking indented code inside a list", () => {
    const inputs = [
      ["- item", "", "      | H |", "      | - |", "      | a\\", "      b |"].join("\n"),
      ["-\t  item", "", "      | H |", "      | - |", "      | a\\", "      b |"].join("\n"),
    ];

    const activeCodec = markdownCodec({
      schema,
      assetPathResolver: unresolvedAssetPathResolver,
    });
    for (const input of inputs) {
      expect(normalizeGfmTableHardBreaks(input)).toBe(input);
      const block = firstParsedBlock(activeCodec, input);
      const code: PMNode[] = [];
      block.descendants((node) => {
        if (node.type.name === "code_block") code.push(node);
      });
      expect(code[0]?.textContent).toContain("a\\\nb |");
      const serialized = activeCodec.serializeBlock(block);
      expect(firstParsedBlock(activeCodec, serialized).toJSON()).toEqual(block.toJSON());
    }
  });

  it("recognizes tables beneath padded list markers", () => {
    const inputs = [
      ["-   item", "", "      | H |", "      | - |", "      | a\\", "      b |"].join("\n"),
      ["-\titem", "", "\t  | H |", "\t  | - |", "\t  | a\\", "\t  b |"].join("\n"),
    ];

    for (const activeCodec of [
      markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
      codec,
    ]) {
      for (const input of inputs) {
        const block = firstParsedBlock(activeCodec, input);
        const hardBreaks: PMNode[] = [];
        block.descendants((node) => {
          if (node.type.name === "hard_break") hardBreaks.push(node);
        });
        expect(hardBreaks).toHaveLength(1);
        const serialized = activeCodec.serializeBlock(block);
        expect(firstParsedBlock(activeCodec, serialized).toJSON()).toEqual(block.toJSON());
      }
    }
  });

  it("keeps explicitly escaped HTML tables as prose", () => {
    const input = '\\<table><tbody><tr><td colspan="2">literal</td></tr></tbody></table>';
    const block = firstParsedBlock(codec, input);

    expect(block.type.name).toBe("paragraph");
    expect(block.textContent).toBe(
      '<table><tbody><tr><td colspan="2">literal</td></tr></tbody></table>',
    );
  });

  it("round-trips HTML-spelled tables through blockquotes", () => {
    const html = [
      "<table>",
      "  <tbody>",
      "    <tr>",
      '      <td colspan="2">Section</td>',
      "    </tr>",
      "  </tbody>",
      "</table>",
    ].join("\n");
    const original = schema.node("blockquote", null, [firstParsedBlock(codec, html)]);
    const serialized = codec.serializeBlock(original);

    expect(firstParsedBlock(codec, serialized).toJSON()).toEqual(original.toJSON());
  });

  it("keeps HTML table pipes inert while canonicalizing nested hard breaks", () => {
    const html = [
      "<table>",
      "  <tbody>",
      "    <tr>",
      '      <td colspan="2">left | right<br />down</td>',
      "    </tr>",
      "  </tbody>",
      "</table>",
    ].join("\n");

    for (const activeCodec of [
      markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
      codec,
    ]) {
      const table = firstParsedBlock(activeCodec, html);
      expect(activeCodec.serializeBlock(table)).toBe(html);
      expect(firstParsedBlock(activeCodec, html).toJSON()).toEqual(table.toJSON());
    }
  });

  /**
   * A pipe table whose cells carry hard breaks, and the containers a writer can
   * nest one inside.
   *
   * One corpus rather than a fixture per container: the rule is the same
   * wherever the table sits — `\` at the end of the line, never `<br>`, and a
   * round trip that lands on the same document — so a container is a row and a
   * cell shape is a row, and both codecs run every combination.
   */
  type BrokenCellMarks = readonly (readonly ReturnType<typeof m>[])[];

  /** Marks on the broken cell text; one entry breaks the body row alone. */
  const BROKEN_CELL_SHAPES: readonly { shape: string; rowMarks: BrokenCellMarks }[] = [
    { shape: "plain cell text", rowMarks: [[]] },
    { shape: "marked cell text", rowMarks: [[m("strong")]] },
    { shape: "differently marked text in both rows", rowMarks: [[m("strong")], [m("em")]] },
  ];

  function tableWithBrokenCells(rowMarks: BrokenCellMarks): PMNode {
    const table = firstParsedBlock(codec, "| H |\n| - |\n| a |");
    const firstBroken = table.childCount - rowMarks.length;
    const rows = [0, 1].map((rowIndex) => {
      const row = table.child(rowIndex);
      if (rowIndex < firstBroken) return row;
      const cell = row.child(0);
      return row.type.create(row.attrs, [
        cell.type.create(cell.attrs, [
          paragraph(
            t(rowIndex === 0 ? "head" : "body", rowMarks[rowIndex - firstBroken]),
            schema.node("hard_break"),
            t("down"),
          ),
        ]),
      ]);
    });
    return table.type.create(table.attrs, rows);
  }

  const quote = (block: PMNode): PMNode => schema.node("blockquote", null, [block]);

  const bulletItem = (...content: PMNode[]): PMNode =>
    schema.node("bullet_list", { tight: true }, [schema.node("list_item", null, content)]);

  const twoListsDeep = (block: PMNode): PMNode =>
    bulletItem(paragraph(t("outer")), bulletItem(paragraph(t("inner")), block));

  it.each([
    { container: "a blockquote", wrap: quote },
    {
      container: "a list item",
      wrap: (table: PMNode) => bulletItem(paragraph(t("Details")), table),
    },
    { container: "a list nested in a list", wrap: twoListsDeep },
    {
      container: "a blockquote two lists deep",
      wrap: (table: PMNode) => twoListsDeep(quote(table)),
    },
    {
      container: "a blockquote under an ordered list",
      wrap: (table: PMNode) =>
        schema.node("ordered_list", { order: 1, tight: true }, [
          schema.node("list_item", null, [
            paragraph(t("outer")),
            bulletItem(paragraph(t("inner")), quote(table)),
          ]),
        ]),
    },
  ])("keeps pipe-cell hard breaks canonical inside $container", ({ wrap }) => {
    for (const { shape, rowMarks } of BROKEN_CELL_SHAPES) {
      const original = wrap(tableWithBrokenCells(rowMarks));

      for (const activeCodec of [
        markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
        codec,
      ]) {
        const serialized = activeCodec.serializeBlock(original);
        expect(serialized, shape).toContain("\\\n");
        expect(serialized, shape).not.toContain("<br");
        expect(firstParsedBlock(activeCodec, serialized).toJSON(), shape).toEqual(
          original.toJSON(),
        );
      }
    }
  });

  it("declines unsupported or conflicting HTML alignment styles", () => {
    for (const cell of [
      '<td style="color:red">A</td>',
      '<td align="left" style="text-align: right">A</td>',
    ]) {
      const input = `<table><tbody><tr>${cell}</tr></tbody></table>`;
      expect(firstParsedBlock(codec, input).type.name).not.toBe("table");
    }
  });

  it("keeps a plain-GFM LitRPG status screen in pipes", () => {
    const gfm = [
      "| Stat | Value |",
      "| ---- | ----: |",
      "| Level | 42 |",
      "| Health | 810 |",
      "| Mana | 275 |",
      "",
    ].join("\n");

    expect(codec.serialize(codec.parse(gfm).blocks)).toBe(
      [
        "| Stat   | Value |",
        "| ------ | ----: |",
        "| Level  |    42 |",
        "| Health |   810 |",
        "| Mana   |   275 |",
        "",
      ].join("\n"),
    );
  });

  it("throws rather than silently dropping malformed column widths", () => {
    const table = firstParsedBlock(codec, "| A |\n| - |\n| 1 |");
    const firstRow = table.child(0);
    const firstCell = firstRow.child(0);
    const withColwidth = (colwidth: unknown) => {
      const cell = firstCell.type.create({ ...firstCell.attrs, colwidth }, firstCell.content);
      return table.type.create(table.attrs, [
        firstRow.type.create(firstRow.attrs, [cell]),
        table.child(1),
      ]);
    };

    // One entry per spanned column, non-negative: a slot count that cannot
    // describe the cell, a negative width, and a fraction are all lies.
    for (const colwidth of [[120, 80], [], [-1], ["120"], [Number.NaN]]) {
      expect(() => codec.serializeBlock(withColwidth(colwidth))).toThrow(
        "colwidth must be null or one non-negative width per spanned column",
      );
    }

    // Sizing a spanned column divides the cell's box by its colspan, so a
    // fraction is what a real drag leaves behind. The wire rounds it.
    expect(codec.serializeBlock(withColwidth([173.5]))).toContain('widths="174"');

    // Zero is not malformed: it is prosemirror-tables' "this column has no
    // width", which a resize leaves in every slot it did not touch.
    expect(codec.serializeBlock(withColwidth([0]))).not.toContain("widths=");
  });

  it("rejects the align-left ghost state", () => {
    const ghost = schema.nodes.paragraph.create({ align: "left" }, t("prose"));
    expect(() => codec.serializeBlock(ghost)).toThrow('invalid Layout align value "left"');
  });
});
