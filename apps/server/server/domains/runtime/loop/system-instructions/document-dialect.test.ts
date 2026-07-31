/** Drift gate between the model-facing dialect card and the document codec. */

import { createAssetPathResolver, mdxCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_DIALECT_CONTRACT,
  DOCUMENT_DIALECT_CORE_INSTRUCTION,
  DOCUMENT_DIALECT_ROUND_TRIP_SPELLINGS,
} from "./document-dialect.js";

const schema = buildDocumentSchema();
const codec = mdxCodec({
  schema,
  assetPathResolver: createAssetPathResolver([
    [DOCUMENT_DIALECT_CONTRACT.image.assetId, DOCUMENT_DIALECT_CONTRACT.image.path],
  ]),
});

function documentJson(blocks: readonly PMNode[]): unknown {
  return schema.node("doc", null, blocks).toJSON();
}

function expectWireFixpoint(wire: string): PMNode[] {
  const parsed = codec.parse(wire).blocks;
  const serialized = codec.serialize(parsed);
  expect(serialized).toBe(`${wire}\n`);
  expect(documentJson(codec.parse(serialized).blocks)).toEqual(documentJson(parsed));
  return parsed;
}

function descendantsOfType(blocks: readonly PMNode[], type: string): PMNode[] {
  const matches: PMNode[] = [];
  for (const block of blocks) {
    if (block.type.name === type) matches.push(block);
    block.descendants((node) => {
      if (node.type.name === type) matches.push(node);
    });
  }
  return matches;
}

function requiredBlock(block: PMNode | undefined): PMNode {
  if (!block) throw new Error("expected the dialect spelling to parse one block");
  return block;
}

describe("document dialect card codec gate", () => {
  it.each(DOCUMENT_DIALECT_ROUND_TRIP_SPELLINGS)("round-trips the claimed $id spelling", ({
    wire,
  }) => {
    expectWireFixpoint(wire);
  });

  it("maps the wikilink spelling to an ordinary link and declines labeled syntax", () => {
    const [wikilink] = expectWireFixpoint(DOCUMENT_DIALECT_CONTRACT.wikilink.wire);
    expect(wikilink?.firstChild?.marks[0]?.attrs.href).toBe(
      DOCUMENT_DIALECT_CONTRACT.wikilink.wire,
    );

    const labeled = codec.parse(DOCUMENT_DIALECT_CONTRACT.wikilink.labeledLiteral).blocks;
    expect(labeled[0]?.rangeHasMark(0, labeled[0].content.size, schema.marks.link)).toBe(false);
    expect(codec.serialize(labeled)).not.toContain(
      DOCUMENT_DIALECT_CONTRACT.wikilink.labeledLiteral,
    );
  });

  it("preserves fenced language attributes, including mermaid", () => {
    for (const spelling of DOCUMENT_DIALECT_CONTRACT.codeFences) {
      const [block] = expectWireFixpoint(spelling.wire);
      expect(block?.type.name).toBe("code_block");
      expect(block?.attrs.language).toBe(spelling.language);
    }
  });

  it("understands pipe ingress but echoes only HTML", () => {
    const pipes = "| Skill | Rank |\n| - | -: |\n| Iron Body | 7 |";
    const pipeBreak = "| Detail |\n| - |\n| one\\\ntwo |";
    const [plain] = codec.parse(pipes).blocks;
    const hardBreak = codec.parse(pipeBreak).blocks;
    const serialized = codec.serializeBlock(requiredBlock(plain));

    expect(plain?.type.name).toBe("table");
    expect(serialized).toContain("<table>");
    expect(serialized).not.toContain("| Skill");
    expect(codec.serializeBlock(requiredBlock(codec.parse(serialized).blocks[0]))).toBe(serialized);
    expect(descendantsOfType(hardBreak, "hard_break")).toHaveLength(1);
  });

  it("maps the claimed HTML table and its block cell children", () => {
    const [table] = expectWireFixpoint(DOCUMENT_DIALECT_CONTRACT.table.wire);
    expect(table?.type.name).toBe("table");
    expect(descendantsOfType([requiredBlock(table)], "paragraph")).toHaveLength(4);
    expect(descendantsOfType([requiredBlock(table)], "bullet_list")).toHaveLength(1);
  });

  it("maps every claimed Layout form to block attributes", () => {
    const [center, right, widths] = DOCUMENT_DIALECT_CONTRACT.layouts.map(({ wire }) => {
      const [block] = expectWireFixpoint(wire);
      return block;
    });

    expect(center?.attrs.align).toBe("center");
    expect(right?.attrs.align).toBe("right");
    expect(widths?.type.name).toBe("table");
    expect(widths?.firstChild?.child(0).attrs.colwidth).toEqual([120]);
    expect(widths?.firstChild?.child(1).attrs.colwidth).toBeNull();
    expect(widths?.firstChild?.child(2).attrs.colwidth).toEqual([80]);
  });

  it("resolves the claimed project-relative image path to stable asset identity", () => {
    const [paragraph] = expectWireFixpoint(DOCUMENT_DIALECT_CONTRACT.image.wire);
    expect(paragraph?.firstChild?.type.name).toBe("image");
    expect(paragraph?.firstChild?.attrs.src).toBe(
      `${DOCUMENT_DIALECT_CONTRACT.syntax.internalAssetPrefix}${DOCUMENT_DIALECT_CONTRACT.image.assetId}`,
    );
    expect(paragraph?.firstChild?.attrs.width).toBeNull();
  });

  // The escalation ladder the card teaches: the raw tag is what carries a
  // display width, and taking the width away puts the picture back in Markdown
  // syntax byte for byte.
  it("maps the claimed sized image spelling to a width, and back down without one", () => {
    const [paragraph] = expectWireFixpoint(DOCUMENT_DIALECT_CONTRACT.image.sizedWire);
    const picture = paragraph?.firstChild;
    expect(picture?.type.name).toBe("image");
    expect(picture?.attrs.width).toBe(240);
    expect(picture?.attrs.src).toBe(
      `${DOCUMENT_DIALECT_CONTRACT.syntax.internalAssetPrefix}${DOCUMENT_DIALECT_CONTRACT.image.assetId}`,
    );

    if (!picture) throw new Error("expected the sized spelling to parse a picture");
    const unsized = schema.node("paragraph", null, [
      picture.type.create({ ...picture.attrs, width: null }),
    ]);
    expect(codec.serialize([unsized])).toBe(`${DOCUMENT_DIALECT_CONTRACT.image.wire}\n`);
  });

  it("ships only spellings represented by the codec contract", () => {
    for (const { opening } of DOCUMENT_DIALECT_CONTRACT.layouts.slice(0, 2)) {
      expect(DOCUMENT_DIALECT_CORE_INSTRUCTION).toContain(opening);
    }
    expect(DOCUMENT_DIALECT_CORE_INSTRUCTION).toContain(
      DOCUMENT_DIALECT_CONTRACT.layouts[2].opening.slice("<Layout ".length, -1),
    );
    expect(DOCUMENT_DIALECT_CORE_INSTRUCTION).toContain(DOCUMENT_DIALECT_CONTRACT.wikilink.wire);
    expect(DOCUMENT_DIALECT_CORE_INSTRUCTION).toContain(
      DOCUMENT_DIALECT_CONTRACT.wikilink.labeledLiteral,
    );
    for (const spelling of [
      DOCUMENT_DIALECT_CONTRACT.codeFences[0].opening,
      DOCUMENT_DIALECT_CONTRACT.codeFences[1].opening,
      DOCUMENT_DIALECT_CONTRACT.syntax.htmlTable.open,
      DOCUMENT_DIALECT_CONTRACT.syntax.htmlLiteralNewline,
      DOCUMENT_DIALECT_CONTRACT.syntax.htmlHardBreak,
      DOCUMENT_DIALECT_CONTRACT.syntax.layoutClose,
      DOCUMENT_DIALECT_CONTRACT.syntax.internalAssetPrefix,
      DOCUMENT_DIALECT_CONTRACT.image.wire,
      DOCUMENT_DIALECT_CONTRACT.image.sizedWire,
    ]) {
      expect(DOCUMENT_DIALECT_CORE_INSTRUCTION).toContain(spelling);
    }
    expect(DOCUMENT_DIALECT_CORE_INSTRUCTION).toContain(
      DOCUMENT_DIALECT_CONTRACT.table.ingressNote,
    );
    expect(DOCUMENT_DIALECT_CORE_INSTRUCTION).toContain(DOCUMENT_DIALECT_CONTRACT.table.wire);
  });
});
