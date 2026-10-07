// Writing a document's own exported Markdown back over it must change nothing.
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { prosemirrorBlocksForDoc } from "../model/y-prosemirror.js";
import { expectOutcome } from "./test-support/assertions.js";
import { codec, harness, schema } from "./test-support/write-tool-harness.js";

const DOC_ID = "chapter.md";
const text = (value: string, ...marks: Array<"strong" | "em" | "strike">) =>
  schema.text(
    value,
    marks.map((mark) => schema.marks[mark].create()),
  );
const hardBreak = () => schema.node("hard_break");
const paragraph = (...children: PMNode[]) => schema.node("paragraph", null, children);
const fromMarkdown = (markdown: string) => codec.parse(markdown).blocks;

function harnessWith(blocks: readonly PMNode[]) {
  const ctx = harness();
  const doc = new Y.Doc({ gc: false });
  prosemirrorToYXmlFragment(
    schema.node("doc", null, [...blocks]),
    doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
  );
  ctx.coordinator.docs.set(DOC_ID, doc);
  ctx.journal.setCheckpoint(DOC_ID, Y.encodeStateAsUpdate(doc));
  return { ...ctx, doc };
}

function exported(doc: Y.Doc): string {
  return codec.serialize(prosemirrorBlocksForDoc(doc, schema));
}

function overwrite(ctx: ReturnType<typeof harness>, content: string) {
  return ctx.core.write({ command: "create", file: DOC_ID, overwrite: true, content }, {});
}

const cases: Array<{ name: string; blocks: PMNode[] }> = [
  { name: "a picture inside a paragraph", blocks: fromMarkdown("Before ![a](assets/a.png) after") },
  {
    name: "pictures at a paragraph's edges",
    blocks: fromMarkdown("![a](assets/a.png) middle ![b](assets/b.png)"),
  },
  { name: "a picture alone", blocks: fromMarkdown("![a](assets/a.png)") },
  {
    name: "paragraphs without marks",
    blocks: fromMarkdown("Plain prose.\n\n“Dialogue,” she said… then — a dash."),
  },
  {
    name: "a hard break mid-paragraph",
    blocks: [paragraph(text("one"), hardBreak(), text("two"))],
  },
  { name: "a hard break ending a paragraph", blocks: [paragraph(text("one"), hardBreak())] },
  {
    name: "overlapping bold and italic",
    blocks: [paragraph(text("a ", "strong"), text("b", "strong", "em"), text(" c", "em"))],
  },
  {
    name: "italic, bold, italic",
    blocks: [paragraph(text("x", "em"), text("y", "strong"), text("z", "em"))],
  },
  {
    name: "bold, italic, bold",
    blocks: [paragraph(text("x", "strong"), text("y", "em"), text("z", "strong"))],
  },
  {
    name: "strike whose edges sit on spaces",
    blocks: [paragraph(text("Lin"), text(" Feng nasc", "strike"), text("ent "), text("x"))],
  },
  {
    name: "headings, marks, links and code",
    blocks: fromMarkdown(
      "# Title\n\nSome **bold** and *italic* with [a *link*](https://example.com) and `a ``tick`.",
    ),
  },
  {
    name: "spaces, literals and empty paragraphs",
    blocks: [
      ...fromMarkdown("&#x20; leading and  double spaces\tand nbsp"),
      paragraph(),
      ...fromMarkdown("Literal \\* \\_ \\[ \\] \\< \\> \\{ \\}"),
    ],
  },
  { name: "a table", blocks: fromMarkdown("| a | b |\n| - | - |\n| 1 | 2 |") },
];

describe("overwrite with a document's own export", () => {
  it.each(cases)("leaves $name untouched", async ({ blocks }) => {
    const ctx = harnessWith(blocks);
    const before = Y.encodeStateVector(ctx.doc);
    const markdown = exported(ctx.doc);

    expectOutcome(await overwrite(ctx, markdown), "success");

    expect(Y.encodeStateVector(ctx.doc)).toEqual(before);
    expect(exported(ctx.doc)).toBe(markdown);
  });

  it("an edit beside a picture and a break keeps exactly one of each", async () => {
    const ctx = harnessWith([
      paragraph(
        text("Before "),
        ...fromMarkdown("![a](assets/a.png)")[0].content.content,
        text(" after"),
        hardBreak(),
        text("tail"),
      ),
    ]);

    expectOutcome(
      await ctx.core.write(
        { command: "replace", file: DOC_ID, find: "after", content: "later" },
        {},
      ),
      "success",
    );

    expect(exported(ctx.doc)).toBe("Before ![a](assets/a.png) later\\\ntail\n");
  });

  it("keeps an anchor in a paragraph the overwrite does not change", async () => {
    const ctx = harnessWith(
      fromMarkdown("The untouched opening line.\n\nA middle line.\n\nThe closing word here."),
    );
    const firstText = (
      ctx.doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(0) as Y.XmlElement
    ).get(0) as Y.XmlText;
    const anchor = Y.createRelativePositionFromTypeIndex(firstText, 8);
    const markdown = exported(ctx.doc).replace("closing word", "closing phrase");

    expectOutcome(await overwrite(ctx, markdown), "success");

    expect(exported(ctx.doc)).toBe(markdown);
    const resolved = Y.createAbsolutePositionFromRelativePosition(anchor, ctx.doc);
    expect(resolved?.type).toBe(firstText);
    expect(resolved?.index).toBe(8);
  });
});
