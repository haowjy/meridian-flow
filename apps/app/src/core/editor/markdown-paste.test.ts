/**
 * The markdown paste door.
 *
 * Every case goes through the exported `clipboardTextParser` with a real
 * schema, because the question at this boundary is always the same one: does
 * the writer get the document the clipboard describes, or the characters it
 * contains?
 */
import {
  createAssetPathResolver,
  markdownCodec,
  unresolvedAssetPathResolver,
} from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Fragment, Node as PMNode, ResolvedPos, Schema, Slice } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { describe, expect, it } from "vitest";

import { markdownClipboardParser, markdownPasteAddsStructure } from "./markdown-paste";

const schema = buildDocumentSchema();
const parse = markdownClipboardParser(schema);

const tableMarkdown = "| Stat | Value |\n| :-- | --: |\n| Strength | 128 |\n";

/** What an AI relay actually emits into a writer's clipboard. */
const aiChunk = [
  "## The sect gate",
  "",
  "The elder paused. See [the ledger](https://example.com/ledger) and [[Cloud Peak]].",
  "",
  "- gather the disciples",
  "- seal the gate",
  "",
  "```ts",
  "const qi = 1;",
  "```",
  "",
  tableMarkdown.trimEnd(),
  "",
  "---",
].join("\n");

// A caret in an ordinary top-level paragraph: a destination that can host blocks.
const inParagraph = resolveInside(
  schema.node("doc", null, [schema.node("paragraph", null, schema.text("x"))]),
);

const inTableCell = resolveInside(
  schema.node("doc", null, [
    schema.node("table", null, [
      schema.node("table_row", null, [
        schema.node("table_cell", null, [schema.node("paragraph", null, schema.text("x"))]),
      ]),
    ]),
  ]),
);

const inCodeBlock = resolveInside(
  schema.node("doc", null, [schema.node("code_block", null, schema.text("x"))]),
);

function paste(text: string, $context: ResolvedPos = inParagraph, plain = false) {
  return parse(text, $context, plain, editorViewFor(schema));
}

describe("markdown paste builds the document the clipboard describes", () => {
  it("turns an AI-emitted chunk into every block it names", () => {
    const slice = paste(aiChunk);
    if (!slice) throw new Error("expected a markdown slice");

    expect(blocksFromSlice(slice).map((block) => block.type.name)).toEqual([
      "heading",
      "paragraph",
      "bullet_list",
      "code_block",
      "table",
      "horizontal_rule",
    ]);
  });

  it("keeps the fence's language rather than its backticks", () => {
    const slice = paste("```ts\nconst qi = 1;\n```");
    if (!slice) throw new Error("expected a markdown slice");
    const [block] = blocksFromSlice(slice);

    expect(block?.attrs.language).toBe("ts");
    expect(block?.textContent).toBe("const qi = 1;");
  });

  it("carries a link as a mark instead of literal bracket syntax", () => {
    const slice = paste("See [the ledger](https://example.com/ledger).");
    if (!slice) throw new Error("expected a markdown slice");

    expect(textOf(slice)).toBe("See the ledger.");
    expect(hrefsIn(slice)).toEqual(["https://example.com/ledger"]);
  });

  it("carries a wikilink in the spelling the link system reads", () => {
    const slice = paste("See [[Cloud Peak]] before dusk.");
    if (!slice) throw new Error("expected a markdown slice");

    expect(textOf(slice)).toBe("See Cloud Peak before dusk.");
    expect(hrefsIn(slice)).toEqual(["[[Cloud Peak]]"]);
  });

  it("still reads a table pasted with CRLF line endings", () => {
    const slice = paste("| A | B |\r\n| --- | --- |\r\n| 1 | 2 |\r\n");
    if (!slice) throw new Error("expected a markdown slice");

    expect(blocksFromSlice(slice).map((block) => block.type.name)).toEqual(["table"]);
  });

  it("resolves a known pasted asset path to its stable image ref", () => {
    const withAssets = markdownClipboardParser(
      schema,
      createAssetPathResolver([["map-id", "assets/map.png"]]),
    );
    const slice = withAssets(
      "![Realm map](assets/map.png)",
      inParagraph,
      false,
      editorViewFor(schema),
    );
    if (!slice) throw new Error("expected a markdown slice");

    let src: unknown;
    slice.content.descendants((node) => {
      if (node.type.name === "image") src = node.attrs.src;
    });
    expect(src).toBe("asset:map-id");
  });
});

describe("prose stays prose", () => {
  // Declining hands the paste back to ProseMirror's own plain-text handling,
  // which is the whole point: text the codec would only re-spell must never
  // take a detour through the codec.
  const prose = [
    ["one plain sentence", "The elder paused before speaking."],
    ["two plain paragraphs", "The elder paused.\n\nThe gate held."],
    ["soft-wrapped lines", "The elder paused\nbefore speaking."],
    ["a hash inside a sentence", "He typed # into the channel."],
    ["a bare url", "See https://example.com now."],
    ["an asterisk used as punctuation", 'She said, "the * marks a scene break".'],
    ["an underscore inside a word", "Open my_var_name and read it."],
    ["angle brackets in dialogue", "He muttered <sigh> and left."],
    ["braces in prose", "The rule {a} applies."],
  ] as const;

  for (const [name, text] of prose) {
    it(`declines ${name}`, () => {
      expect(paste(text)).toBeUndefined();
    });
  }

  it("declines empty text", () => {
    expect(paste("")).toBeUndefined();
  });
});

describe("the destination has the last word", () => {
  it("keeps literal text when the caret is in a code block", () => {
    expect(paste(aiChunk, inCodeBlock)).toBeUndefined();
  });

  it("keeps literal text when paste-without-formatting was asked for", () => {
    expect(paste(aiChunk, inParagraph, true)).toBeUndefined();
  });

  it("declines block structure inside a table cell, which cannot hold it", () => {
    expect(paste(tableMarkdown, inTableCell)).toBeUndefined();
    expect(paste("## Heading", inTableCell)).toBeUndefined();
  });

  it("still marks up inline markdown inside a table cell", () => {
    const slice = paste("**bold**", inTableCell);
    if (!slice) throw new Error("expected a markdown slice");

    expect(textOf(slice)).toBe("bold");
    expect(marksIn(slice)).toEqual(["strong"]);
  });
});

describe("the slice joins the sentence or breaks the block, deliberately", () => {
  it("leaves a lone paragraph open so it merges into the caret's sentence", () => {
    const slice = paste("a **bold** word");
    if (!slice) throw new Error("expected a markdown slice");

    expect([slice.openStart, slice.openEnd]).toEqual([1, 1]);
  });

  it("closes a slice that carries blocks, so their structure survives", () => {
    const slice = paste("## Heading\n\nAnd *prose*.");
    if (!slice) throw new Error("expected a markdown slice");

    expect([slice.openStart, slice.openEnd]).toEqual([0, 0]);
  });
});

describe("markdownPasteAddsStructure", () => {
  const gains = [
    ["a heading", "## Scene"],
    ["a list", "- a\n- b"],
    ["a fence", "```\nx\n```"],
    ["a table", tableMarkdown],
    ["a divider", "---"],
    ["a blockquote", "> quoted"],
    ["emphasis", "He was *very* tired."],
    ["a link", "See [it](https://example.com)."],
    ["an image", "![m](assets/map.png)"],
    ["an explicit hard break", "line one  \nline two"],
  ] as const;

  for (const [name, text] of gains) {
    it(`accepts ${name}`, () => {
      expect(markdownPasteAddsStructure(blocksOf(text))).toBe(true);
    });
  }

  const noGain = [
    ["nothing", ""],
    ["one sentence", "The elder paused."],
    ["two paragraphs", "One.\n\nTwo."],
    ["soft-wrapped lines", "line one\nline two"],
  ] as const;

  for (const [name, text] of noGain) {
    it(`rejects ${name}`, () => {
      expect(markdownPasteAddsStructure(blocksOf(text))).toBe(false);
    });
  }
});

/** The predicate judges codec output, so the fixtures are codec output. */
function blocksOf(text: string): PMNode[] {
  return [
    ...markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }).parse(text).blocks,
  ];
}

function editorViewFor(schema: Schema): EditorView {
  return { state: { schema } } as EditorView;
}

/** Resolve a position inside the document's first textblock. */
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

function textOf(slice: Slice): string {
  return slice.content.textBetween(0, slice.content.size, "");
}

function hrefsIn(slice: Slice): string[] {
  const hrefs: string[] = [];
  slice.content.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name === "link") hrefs.push(String(mark.attrs.href));
    }
  });
  return hrefs;
}

function marksIn(slice: Slice): string[] {
  const names: string[] = [];
  slice.content.descendants((node) => {
    for (const mark of node.marks) names.push(mark.type.name);
  });
  return names;
}
