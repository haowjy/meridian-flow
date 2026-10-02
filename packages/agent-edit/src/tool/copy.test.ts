// Block copy (`from`) and whole-document copy (`copy`): exact nodes, fresh identity, bounded receipts.
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";

import { renderAgentEditResult } from "./result-text.js";
import { blockTexts, expectOutcome, hashAt, outcomeText } from "./test-support/assertions.js";
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
    expect(blockTexts(dest)).toEqual([
      "Opening.",
      "First copied line.",
      "",
      "",
      "  Spaced   text  stays exact.",
      "Closing.",
    ]);
    const copiedHashes = [1, 2, 3, 4].map((index) => hashAt(dest, index));
    expect(copiedHashes.some((hash) => sourceHashes.includes(hash))).toBe(false);
    expect(result.result.copied).toEqual({ from: "src.md", blocks: 4 });
    expect(outcomeText(result)).toBe(
      [
        "status: success; path: dest.md; write: w1; copied: 4 blocks from src.md",
        "",
        `${copiedHashes[0]}|First copied line.`,
        // Receipt lines are serialized markup, which escapes the leading spaces.
        `${copiedHashes[3]}|&#x20; Spaced   text  stays exact.`,
      ].join("\n"),
    );
    // The copy is the agent's write, journaled with its own origin.
    const [update] = (await ctx.journal.read("dest.md")).updates;
    expect(update?.meta.origin).toMatch(/^agent:/);
  });

  it("copies the selected blocks and undoes like any write", async () => {
    const ctx = harness({ "dest.md": "Opening." });
    seed(ctx, "src.md", SOURCE);
    await ctx.core.read({ file: "dest.md" }, context);
    const before = nodesJson(ctx.liveDoc("dest.md"));
    const nodes = await sourceNodes(ctx, "src.md", { in: [2, 3] });

    const copied = await ctx.core.write(
      { command: "insert", file: "dest.md", from: { path: "src.md", in: [2, 3] } },
      { ...context, copiedNodes: nodes },
    );
    expectOutcome(copied, "success");
    expect(blockTexts(ctx.liveDoc("dest.md"))).toEqual(["Opening.", "", ""]);

    const undone = await ctx.core.write({ command: "undo", file: "dest.md" }, context);
    expect(undone.status).toBe("reversed");
    expect(nodesJson(ctx.liveDoc("dest.md"))).toEqual(before);
  });

  it("replaces the selected blocks with copies, reusing none of them", async () => {
    const ctx = harness({ "dest.md": "Keep.\n\nOld one.\n\nOld two.\n\nTail." });
    seed(ctx, "src.md", [paragraph("New.")]);
    await ctx.core.read({ file: "dest.md" }, context);
    const oldHashes = [1, 2].map((index) => hashAt(ctx.liveDoc("dest.md"), index));
    const nodes = await sourceNodes(ctx, "src.md");

    const result = await ctx.core.write(
      { command: "replace", file: "dest.md", in: [2, 3], from: { path: "src.md" } },
      { ...context, copiedNodes: nodes },
    );

    expectOutcome(result, "success");
    expect(blockTexts(ctx.liveDoc("dest.md"))).toEqual(["Keep.", "New.", "Tail."]);
    expect(oldHashes).not.toContain(hashAt(ctx.liveDoc("dest.md"), 1));
    expect(result.result.write?.deletedHashes).toEqual(expect.arrayContaining(oldHashes));
    expect(outcomeText(result).split("\n")[0]).toBe(
      "status: success; path: dest.md; write: w1; copied: 1 block from src.md",
    );
  });

  it("refuses a from write when the host supplied no source blocks", async () => {
    const ctx = harness({ "dest.md": "Opening." });
    await ctx.core.read({ file: "dest.md" }, context);

    const result = await ctx.core.write(
      { command: "insert", file: "dest.md", from: { path: "src.md" } },
      context,
    );

    expectOutcome(result, "invalid_write", true);
  });

  it("keeps the receipt bounded for a 3,000-word source, staged and settled", async () => {
    const ctx = harness({ "dest.md": "Opening." });
    const words = (count: number, seedWord: string) =>
      Array.from({ length: count }, (_, index) => `${seedWord}${index}`).join(" ");
    seed(ctx, "src.md", [
      paragraph(words(1_000, "alpha")),
      ...Array.from({ length: 19 }, (_, index) => paragraph(words(100, `w${index}x`))),
      paragraph("終".repeat(1_000)),
    ]);
    await ctx.core.read({ file: "dest.md" }, context);
    const nodes = await sourceNodes(ctx, "src.md");
    const responseContext = { ...context, turnId: "turn-bounded", responseId: "response-bounded" };

    const staged = await ctx.core.write(
      { command: "insert", file: "dest.md", from: { path: "src.md" } },
      { ...responseContext, copiedNodes: nodes },
    );
    expectOutcome(staged, "success");
    const commit = await ctx.core.commitResponse("response-bounded");
    const settled = commit.documents.flatMap((document) => document.receipts)[0]?.result;

    for (const text of [outcomeText(staged), settled ? renderAgentEditResult(settled) : ""]) {
      expect(text).toContain("copied: 21 blocks from src.md");
      expect(text.length).toBeLessThan(400);
    }
    expect(blockTexts(ctx.liveDoc("dest.md"))).toHaveLength(22);
  });
});

describe("whole-document copy", () => {
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
    expect(result.command).toBe("copy");
    expect(outcomeText(result)).toBe(
      "status: success; path: copy.md; write: w1; copied: 4 blocks from src.md",
    );
    expect(ctx.coordinator.docs.has("copy.md")).toBe(false);

    const commit = await ctx.core.commitResponse("response-copy");
    expect(commit.stagedCreates.committed).toEqual(["copy.md"]);
    expect(nodesJson(ctx.liveDoc("copy.md"))).toEqual(nodesJson(ctx.liveDoc("src.md")));
    const settled = commit.documents[0]?.receipts[0]?.result;
    // The host adds `path` and the destination back when it settles the result.
    expect(settled ? renderAgentEditResult(settled) : "").toBe(
      "status: success; write: w1; copied: 4 blocks from src.md",
    );
  });

  it("rolls back with a failed reply", async () => {
    const ctx = harness();
    seed(ctx, "src.md", SOURCE);
    const nodes = await sourceNodes(ctx, "src.md");

    const result = await ctx.core.write(
      { command: "copy", file: "copy.md", from: { path: "src.md" } },
      {
        ...context,
        turnId: "turn-copy-rollback",
        responseId: "response-copy-rollback",
        createdDocument: true,
        copiedNodes: nodes,
      },
    );
    expectOutcome(result, "success");

    const rollback = await ctx.core.rollbackResponse("response-copy-rollback");
    expect(rollback.stagedCreates).toEqual({ committed: [], discarded: ["copy.md"] });
    expect(ctx.coordinator.docs.has("copy.md")).toBe(false);
  });

  it("refuses an existing destination without overwrite and replaces it with overwrite", async () => {
    const ctx = harness({ "copy.md": "Existing text." });
    seed(ctx, "src.md", [paragraph("Copied.")]);
    const nodes = await sourceNodes(ctx, "src.md");

    const refused = await ctx.core.write(
      { command: "copy", file: "copy.md", from: { path: "src.md" } },
      { ...context, copiedNodes: nodes },
    );
    expectOutcome(refused, "invalid_write", true);

    const overwritten = await ctx.core.write(
      { command: "copy", file: "copy.md", from: { path: "src.md" }, overwrite: true },
      { ...context, copiedNodes: nodes },
    );
    expectOutcome(overwritten, "success");
    expect(blockTexts(ctx.liveDoc("copy.md"))).toEqual(["Copied."]);
    expect(overwritten.result.copied).toEqual({ from: "src.md", blocks: 1 });
  });

  it("says the document still exists when undo empties it", async () => {
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
    expect(outcomeText(undone)).toContain(
      "The document at copy.md is empty but still exists until document delete ships.",
    );
  });
});
