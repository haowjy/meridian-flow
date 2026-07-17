import { mdxCodec, unresolvedAssetPathResolver } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Fragment, Node as PMNode, ResolvedPos, Schema, Slice } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { describe, expect, it } from "vitest";

import { looksLikeMarkdownTable, markdownTableClipboardParser } from "./markdown-paste";

const schema = buildDocumentSchema();

const tableMarkdown = "| Stat | Value |\n| :-- | --: |\n| Strength | 128 |\n";

// A caret inside a normal top-level paragraph — a destination that can host a table.
const paragraphContext = resolveInside(
  schema.node("doc", null, [schema.node("paragraph", null, schema.text("x"))]),
);

describe("looksLikeMarkdownTable", () => {
  it("accepts GFM tables with outer pipes", () => {
    expect(looksLikeMarkdownTable(tableMarkdown)).toBe(true);
  });

  it("accepts GFM tables without outer pipes", () => {
    expect(looksLikeMarkdownTable("Stat | Value\n--- | ---\nStrength | 128\n")).toBe(true);
  });

  it("accepts alignment delimiters", () => {
    expect(looksLikeMarkdownTable("| Left | Center | Right |\n| :--- | :----: | ----: |\n")).toBe(
      true,
    );
  });

  it("rejects plain prose", () => {
    expect(looksLikeMarkdownTable("The sect elder paused before speaking.")).toBe(false);
  });

  it("rejects a lone pipe line", () => {
    expect(looksLikeMarkdownTable("one | two")).toBe(false);
  });

  it("rejects bullet lists", () => {
    expect(looksLikeMarkdownTable("- alpha\n- beta\n")).toBe(false);
  });

  it("rejects numbered lists", () => {
    expect(looksLikeMarkdownTable("1. alpha\n2. beta\n")).toBe(false);
  });

  it("rejects normal sentences with markdown punctuation", () => {
    expect(looksLikeMarkdownTable("A normal sentence with *emphasis* and - dashes.")).toBe(false);
  });
});

describe("markdownTableClipboardParser", () => {
  it("returns undefined for non-table markdown so normal plain-text paste can run", () => {
    const parser = markdownTableClipboardParser(schema);

    expect(
      parser("A sentence with *stars*.", paragraphContext, false, editorViewFor(schema)),
    ).toBeUndefined();
  });

  it("returns undefined for table markdown when plain paste is requested", () => {
    const parser = markdownTableClipboardParser(schema);

    expect(parser(tableMarkdown, paragraphContext, true, editorViewFor(schema))).toBeUndefined();
  });

  it("builds a closed table Slice from table markdown", () => {
    const parser = markdownTableClipboardParser(schema);
    const slice = parser(tableMarkdown, paragraphContext, false, editorViewFor(schema));

    expect(slice).toBeDefined();
    expect((slice as Slice).openStart).toBe(0);
    expect((slice as Slice).openEnd).toBe(0);
    expect(containsNodeType(slice as Slice, "table")).toBe(true);
  });

  it("builds a table Slice from CRLF table markdown", () => {
    const parser = markdownTableClipboardParser(schema);
    const slice = parser(
      "| A | B |\r\n| --- | --- |\r\n| 1 | 2 |\r\n",
      paragraphContext,
      false,
      editorViewFor(schema),
    );

    expect(slice).toBeDefined();
    expect(containsNodeType(slice as Slice, "table")).toBe(true);
  });

  it.each([
    [
      "fenced code containing table-looking lines",
      "```\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```\n",
    ],
    ["paragraph plus markdown punctuation", "alpha | beta\n- | -\nC | D"],
    ["prose mixed with a table", `Before the table.\n\n${tableMarkdown}`],
  ])("returns undefined for %s", (_name, markdown) => {
    const parser = markdownTableClipboardParser(schema);

    expect(parser(markdown, paragraphContext, false, editorViewFor(schema))).toBeUndefined();
  });

  it("preserves the parsed table structure", () => {
    const parser = markdownTableClipboardParser(schema);
    const slice = parser(tableMarkdown, paragraphContext, false, editorViewFor(schema));
    if (!slice) throw new Error("expected markdown table slice");

    const originalBlocks = mdxCodec({
      schema,
      assetPathResolver: unresolvedAssetPathResolver,
    }).parse(tableMarkdown).blocks;
    expect(blocksFromSlice(slice).map((node) => node.toJSON())).toEqual(
      originalBlocks.map((node) => node.toJSON()),
    );
  });

  // Inside a table the parser declines (returns undefined) so it never builds a
  // nested-table slice that would split the surrounding table. Paste then falls
  // back to ProseMirror's default plain-text handling. (Pristine literal-text
  // paste inside a cell is stock-editor behavior, tracked under #92.)
  it("declines to convert inside a table cell, deferring to default paste", () => {
    const parser = markdownTableClipboardParser(schema);
    const cellContext = resolveInside(
      schema.node("doc", null, [
        schema.node("table", null, [
          schema.node("table_row", null, [
            schema.node("table_cell", null, [schema.node("paragraph", null, schema.text("x"))]),
          ]),
        ]),
      ]),
    );

    expect(parser(tableMarkdown, cellContext, false, editorViewFor(schema))).toBeUndefined();
  });

  it("returns undefined when pasting inside a code block so literal text is kept", () => {
    const parser = markdownTableClipboardParser(schema);
    const codeContext = resolveInside(
      schema.node("doc", null, [schema.node("code_block", null, schema.text("x"))]),
    );

    expect(parser(tableMarkdown, codeContext, false, editorViewFor(schema))).toBeUndefined();
  });
});

function editorViewFor(schema: Schema): EditorView {
  return { state: { schema } } as EditorView;
}

// Resolve a position inside the document's first textblock.
function resolveInside(doc: PMNode): ResolvedPos {
  let pos: number | null = null;
  doc.descendants((node, nodePos) => {
    if (pos !== null) return false;
    if (node.isTextblock) {
      pos = nodePos + 1;
      return false;
    }
    return true;
  });
  return doc.resolve(pos ?? 1);
}

function containsNodeType(slice: Slice, typeName: string): boolean {
  let found = false;
  slice.content.forEach((node) => {
    if (node.type.name === typeName) found = true;
    node.descendants((child) => {
      if (child.type.name === typeName) found = true;
    });
  });
  return found;
}

function blocksFromSlice(slice: Slice): PMNode[] {
  return childrenOf(slice.content);
}

function childrenOf(fragment: Fragment): PMNode[] {
  const children: PMNode[] = [];
  fragment.forEach((node) => {
    children.push(node);
  });
  return children;
}
