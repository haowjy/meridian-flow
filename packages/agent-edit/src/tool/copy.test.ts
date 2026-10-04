// Block copy (`from`) and document copy (`copy`): exact nodes, fresh identity, bounded receipts.
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";

import { blockTexts, expectOutcome, hashAt } from "./test-support/assertions.js";
import {
  context,
  harness,
  model,
  schema,
  type WriteToolHarness,
} from "./test-support/write-tool-harness.js";

function paragraph(text: string): PMNode {
  return schema.node("paragraph", null, text ? [schema.text(text)] : []);
}

/** Seeds a document node by node, so it can hold what markdown can't (repeated blank paragraphs). */
function seed(ctx: WriteToolHarness, docId: string, blocks: PMNode[]): void {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 5000 + ctx.coordinator.docs.size;
  prosemirrorToYXmlFragment(
    schema.node("doc", null, blocks),
    doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
  );
  ctx.coordinator.docs.set(docId, doc);
  ctx.journal.setCheckpoint(docId, Y.encodeStateAsUpdate(doc));
}

function nodesJson(doc: Y.Doc, from = 0, to?: number): unknown[] {
  return model
    .projectBlocks(doc as never)
    .slice(from, to)
    .map((node) => node.toJSON());
}

async function sourceNodes(
  ctx: WriteToolHarness,
  file: string,
  selection: { in?: [number, number] } = {},
) {
  const read = await ctx.core.read({ file, ...selection }, { ...context, includeNodes: true });
  expectOutcome(read, "success");
  if (!read.nodes) throw new Error("read returned no nodes");
  return read.nodes;
}

const SOURCE = [
  paragraph("First copied line."),
  paragraph(""),
  paragraph(""),
  paragraph("  Spaced   text  stays exact."),
];

describe("block copy (from)", () => {
  it("inserts the exact source nodes, blank paragraphs included, with new hashes", async () => {
    const ctx = harness({ "dest.md": "Opening.\n\nClosing." });
    seed(ctx, "src.md", SOURCE);
    await ctx.core.read({ file: "dest.md" }, context);
    const nodes = await sourceNodes(ctx, "src.md");
    const sourceHashes = model.getBlocks(ctx.liveDoc("src.md")).map((b) => model.getBlockId(b));

    const result = await ctx.core.write(
      {
        command: "insert",
        file: "dest.md",
        after: hashAt(ctx.liveDoc("dest.md"), 0),
        from: { path: "src.md" },
      },
      { ...context, copiedNodes: nodes },
    );

    expectOutcome(result, "success");
    const dest = ctx.liveDoc("dest.md");
    expect(nodesJson(dest, 1, 5)).toEqual(nodesJson(ctx.liveDoc("src.md")));
    const copiedHashes = [1, 2, 3, 4].map((index) => hashAt(dest, index));
    expect(copiedHashes.some((hash) => sourceHashes.includes(hash))).toBe(false);
    expect(result.result.copied).toEqual({ from: "src.md", blocks: 4 });
  });
});

describe("document copy", () => {
  it("creates the copy as a staged create that commits with the source's nodes", async () => {
    const ctx = harness();
    seed(ctx, "src.md", SOURCE);
    const nodes = await sourceNodes(ctx, "src.md");
    const responseContext = {
      ...context,
      turnId: "turn-copy",
      responseId: "response-copy",
      createdDocument: true,
    };

    const result = await ctx.core.write(
      { command: "copy", file: "copy.md", from: { path: "src.md" } },
      { ...responseContext, copiedNodes: nodes },
    );

    expectOutcome(result, "success");
    expect(ctx.coordinator.docs.has("copy.md")).toBe(false);

    const commit = await ctx.core.commitResponse("response-copy");
    expect(commit.stagedCreates.committed).toEqual(["copy.md"]);
    expect(nodesJson(ctx.liveDoc("copy.md"))).toEqual(nodesJson(ctx.liveDoc("src.md")));
  });

  it("undoes a copy back to an empty document", async () => {
    const ctx = harness();
    seed(ctx, "src.md", [paragraph("Copied.")]);
    const nodes = await sourceNodes(ctx, "src.md");
    const copied = await ctx.core.write(
      { command: "copy", file: "copy.md", from: { path: "src.md" } },
      { ...context, copiedNodes: nodes },
    );
    expectOutcome(copied, "success");

    const undone = await ctx.core.write({ command: "undo", file: "copy.md" }, context);

    expect(undone.status).toBe("reversed");
    expect(blockTexts(ctx.liveDoc("copy.md")).join("")).toBe("");
  });
});
