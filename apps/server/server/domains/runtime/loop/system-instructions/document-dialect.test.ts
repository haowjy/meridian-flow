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

  it("keeps representable tables in pipes and preserves pipe-cell hard breaks", () => {
    const [plain] = expectWireFixpoint(DOCUMENT_DIALECT_CONTRACT.pipeTable.wire);
    expect(plain?.type.name).toBe("table");
    expect(codec.serializeBlock(requiredBlock(plain))).not.toContain("<table>");

    const hardBreak = expectWireFixpoint(DOCUMENT_DIALECT_CONTRACT.pipeTable.hardBreakWire);
    expect(descendantsOfType(hardBreak, "hard_break")).toHaveLength(1);
  });

  it("maps every claimed HTML escalation to the table node", () => {
    for (const spelling of DOCUMENT_DIALECT_CONTRACT.htmlTableEscalations) {
      const [table] = expectWireFixpoint(spelling.wire);
      expect(table?.type.name, spelling.reason).toBe("table");
      expect(
        codec.serializeBlock(requiredBlock(table)).startsWith("<table>"),
        spelling.reason,
      ).toBe(true);
    }
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
      `asset:${DOCUMENT_DIALECT_CONTRACT.image.assetId}`,
    );
  });

  it("ships only spellings represented by the codec contract", () => {
    for (const { reason } of DOCUMENT_DIALECT_CONTRACT.htmlTableEscalations) {
      expect(DOCUMENT_DIALECT_CORE_INSTRUCTION).toContain(reason);
    }
    for (const { form } of DOCUMENT_DIALECT_CONTRACT.layouts) {
      expect(DOCUMENT_DIALECT_CORE_INSTRUCTION).toContain(form);
    }
    expect(DOCUMENT_DIALECT_CORE_INSTRUCTION).toContain(DOCUMENT_DIALECT_CONTRACT.wikilink.wire);
    expect(DOCUMENT_DIALECT_CORE_INSTRUCTION).toContain(
      DOCUMENT_DIALECT_CONTRACT.wikilink.labeledLiteral,
    );
  });
});
