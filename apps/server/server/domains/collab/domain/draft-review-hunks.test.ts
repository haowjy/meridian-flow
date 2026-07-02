/** Unit coverage for draft live-vs-draft hunk extraction and attribution. */
import { toDocHandle, unwrapBlock, yProsemirrorModel } from "@meridian/agent-edit";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { alignBlocks, computeDraftReviewHunks } from "./draft-review-hunks.js";

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema });
const model = yProsemirrorModel(schema);

describe("draft review hunk model", () => {
  it("aligns stable block identities across insert, delete, edit, and move", () => {
    const live = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const draft = [{ id: "b" }, { id: "a" }, { id: "c" }, { id: "e" }];

    expect(alignBlocks(live, draft).map((entry) => entry.kind)).toEqual([
      "delete",
      "equal",
      "insert",
      "equal",
      "delete",
      "insert",
    ]);
  });

  it("classifies same-identity blocks with different content as changed", () => {
    const live = [
      { id: "a", text: "Alpha" },
      { id: "b", text: "Beta" },
    ];
    const draft = [
      { id: "a", text: "Alpha" },
      { id: "b", text: "Beta writer edit" },
    ];

    expect(alignBlocks(live, draft).map((entry) => entry.kind)).toEqual(["equal", "change"]);
  });

  it("extracts word-level changed-block hunks anchored in the draft doc", () => {
    const live = createDoc(
      "Alpha sword. This paragraph has enough unchanged surrounding text for inline review.\n\nBeta stays.",
    );
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 6, to: 11 }, "blade"),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 10, actorTurnId: "turn-a", updateData: update }],
    });

    expect(result).toMatchObject({ reviewMode: "inline" });
    if (result.reviewMode !== "inline") throw new Error("expected inline result");
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]).toMatchObject({ operationIds: ["10"], deletedText: "sword" });
    expect(result.hunks[0].anchor.relStart).toEqual(expect.any(String));
    expect(result.operations).toEqual([
      {
        operationId: "10",
        sourceUpdateIds: [10],
        actorTurnId: "turn-a",
        kind: "agent",
        hunkCount: 1,
      },
    ]);
  });

  it("attributes deleted live text to the row whose delete set covers it", () => {
    const live = createDoc(
      "Alpha sword remains with enough unchanged surrounding text for inline review density.",
    );
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 6, to: 12 }, ""),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 21, actorTurnId: "turn-delete", updateData: update }],
    });

    expect(result.reviewMode).toBe("inline");
    if (result.reviewMode !== "inline") throw new Error("expected inline result");
    expect(result.hunks).toEqual([
      expect.objectContaining({ operationIds: ["21"], deletedText: "sword " }),
    ]);
  });

  it("does not over-attribute cumulative delete sets to later rows", () => {
    const live = createDoc(
      [
        "Alpha target remains with enough unchanged surrounding text for attribution.",
        "Beta target remains with enough unchanged surrounding text for attribution.",
        "Gamma target remains with enough unchanged surrounding text for attribution.",
        "Delta target remains with enough unchanged surrounding text for attribution.",
      ].join("\n\n"),
    );
    const draft = cloneDoc(live);
    const blocks = model.getBlocks(toDocHandle(draft));
    const updates = blocks.map((block) =>
      captureUpdate(draft, () =>
        model.applyTextEdit(toDocHandle(draft), block, { from: 6, to: 13 }, ""),
      ),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: updates.map((update, index) => ({
        id: 161 + index,
        actorTurnId: `turn-${index + 1}`,
        updateData: update,
      })),
    });

    expect(result.reviewMode).toBe("inline");
    if (result.reviewMode !== "inline") throw new Error("expected inline result");
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([
      ["161"],
      ["162"],
      ["163"],
      ["164"],
    ]);
  });

  it("attributes delete undo re-delete to the last effective delete row", () => {
    const live = createDoc(
      "Alpha sword remains with enough unchanged surrounding text for resurrection attribution.",
    );
    const draft = cloneDoc(live);
    const text = firstXmlText(draft);
    const undoManager = new Y.UndoManager(text);
    const firstDelete = captureUpdate(draft, () => text.delete(6, 5));
    const undo = captureUpdate(draft, () => undoManager.undo());
    expect(text.toString()).toContain("sword");
    const secondDelete = captureUpdate(draft, () => text.delete(6, 5));

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 221, actorTurnId: "turn-first-delete", updateData: firstDelete },
        { id: 222, actorTurnId: "turn-undo", updateData: undo },
        { id: 223, actorTurnId: "turn-second-delete", updateData: secondDelete },
      ],
    });

    expect(result.reviewMode).toBe("inline");
    if (result.reviewMode !== "inline") throw new Error("expected inline result");
    expect(result.hunks).toEqual([
      expect.objectContaining({ operationIds: ["223"], deletedText: "sword" }),
    ]);
    expect(result.operations).toEqual([
      {
        operationId: "223",
        sourceUpdateIds: [223],
        actorTurnId: "turn-second-delete",
        kind: "agent",
        hunkCount: 1,
      },
    ]);
  });

  it("attributes delete undo writer re-delete to the writer row", () => {
    const live = createDoc(
      "Alpha sword remains with enough unchanged surrounding text for writer resurrection attribution.",
    );
    const draft = cloneDoc(live);
    const text = firstXmlText(draft);
    const undoManager = new Y.UndoManager(text);
    const agentDelete = captureUpdate(draft, () => text.delete(6, 5));
    const undo = captureUpdate(draft, () => undoManager.undo());
    expect(text.toString()).toContain("sword");
    const writerDelete = captureUpdate(draft, () => text.delete(6, 5));

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 231, actorTurnId: "turn-agent-delete", updateData: agentDelete },
        { id: 232, actorTurnId: "turn-undo", updateData: undo },
        { id: 233, actorTurnId: null, actorUserId: "user-a", updateData: writerDelete },
      ],
    });

    expect(result.reviewMode).toBe("inline");
    if (result.reviewMode !== "inline") throw new Error("expected inline result");
    expect(result.hunks).toEqual([
      expect.objectContaining({ operationIds: ["writer:1"], deletedText: "sword" }),
    ]);
    expect(result.operations).toEqual([
      {
        operationId: "writer:1",
        sourceUpdateIds: [233],
        actorUserId: "user-a",
        kind: "writer",
        hunkCount: 1,
      },
    ]);
  });

  it("keeps one row that genuinely deletes two regions linked to both hunks", () => {
    const live = createDoc(
      [
        "Alpha target remains with enough unchanged surrounding text for attribution.",
        "Beta target remains with enough unchanged surrounding text for attribution.",
        "Gamma stays unchanged with enough surrounding text for attribution.",
      ].join("\n\n"),
    );
    const draft = cloneDoc(live);
    const [first, second] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () => {
      model.applyTextEdit(toDocHandle(draft), first, { from: 6, to: 13 }, "");
      model.applyTextEdit(toDocHandle(draft), second, { from: 5, to: 12 }, "");
    });

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 171, actorTurnId: "turn-two-deletions", updateData: update }],
    });

    expect(result.reviewMode).toBe("inline");
    if (result.reviewMode !== "inline") throw new Error("expected inline result");
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([["171"], ["171"]]);
    expect(result.operations).toEqual([
      {
        operationId: "171",
        sourceUpdateIds: [171],
        actorTurnId: "turn-two-deletions",
        kind: "agent",
        hunkCount: 2,
      },
    ]);
  });

  it("maps a coalesced visual hunk spanning two rows to both operations", () => {
    const live = createDoc(
      "Alpha. Tail text keeps the rewrite ratio low and the hunk density below the fallback cutoff.",
    );
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const firstUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 5, to: 5 }, " brave"),
    );
    const secondUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 12, to: 12 }, " new"),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 31, actorTurnId: "turn-a", updateData: firstUpdate },
        { id: 32, actorTurnId: "turn-b", updateData: secondUpdate },
      ],
    });

    expect(result.reviewMode).toBe("inline");
    if (result.reviewMode !== "inline") throw new Error("expected inline result");
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0].operationIds).toEqual(["31", "32"]);
    expect(result.operations.map((operation) => operation.operationId)).toEqual(["31", "32"]);
  });

  it("treats rows without actor turn or actor user as unattributed agent operations", () => {
    const live = createDoc(
      "Alpha. Tail text keeps hunk density below the fallback cutoff for this unattributed edit.",
    );
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 5, to: 5 }, " writer"),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 41, actorTurnId: null, updateData: update }],
    });

    expect(result.reviewMode).toBe("inline");
    if (result.reviewMode !== "inline") throw new Error("expected inline result");
    expect(result.hunks[0].operationIds).toEqual(["41"]);
    expect(result.operations).toEqual([
      { operationId: "41", sourceUpdateIds: [41], kind: "agent", hunkCount: 1 },
    ]);
  });

  it("clusters writer rows in the same block into one writer operation", () => {
    const live = createDoc(
      "Alpha. Tail text keeps hunk density below the fallback cutoff for this writer edit.",
    );
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const firstUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 5, to: 5 }, " writer"),
    );
    const secondUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 12, to: 12 }, " careful"),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 181, actorTurnId: null, actorUserId: "user-a", updateData: firstUpdate },
        { id: 182, actorTurnId: null, actorUserId: "user-a", updateData: secondUpdate },
      ],
    });

    expect(result.reviewMode).toBe("inline");
    if (result.reviewMode !== "inline") throw new Error("expected inline result");
    expect(new Set(result.hunks.flatMap((hunk) => hunk.operationIds))).toEqual(
      new Set(["writer:1"]),
    );
    expect(result.operations).toEqual([
      {
        operationId: "writer:1",
        sourceUpdateIds: [181, 182],
        actorUserId: "user-a",
        kind: "writer",
        hunkCount: result.hunks.length,
      },
    ]);
  });

  it("clusters writer rows in adjacent changed blocks into one writer operation", () => {
    const live = createDoc(
      [
        "Alpha target remains with enough unchanged surrounding text for attribution.",
        "Beta target remains with enough unchanged surrounding text for attribution.",
        "Gamma stays unchanged with enough surrounding text for attribution.",
      ].join("\n\n"),
    );
    const draft = cloneDoc(live);
    const [first, second] = model.getBlocks(toDocHandle(draft));
    const firstUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 6, to: 12 }, "rewrite"),
    );
    const secondUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), second, { from: 5, to: 11 }, "rewrite"),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 191, actorTurnId: null, actorUserId: "user-a", updateData: firstUpdate },
        { id: 192, actorTurnId: null, actorUserId: "user-a", updateData: secondUpdate },
      ],
    });

    expect(result.reviewMode).toBe("inline");
    if (result.reviewMode !== "inline") throw new Error("expected inline result");
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([["writer:1"], ["writer:1"]]);
    expect(result.operations).toEqual([
      {
        operationId: "writer:1",
        sourceUpdateIds: [191, 192],
        actorUserId: "user-a",
        kind: "writer",
        hunkCount: 2,
      },
    ]);
  });

  it("keeps writer rows separated by an unchanged block in separate operations", () => {
    const live = createDoc(
      [
        "Alpha target remains with enough unchanged surrounding text for attribution.",
        "Beta stays unchanged with enough surrounding text for attribution.",
        "Gamma target remains with enough unchanged surrounding text for attribution.",
      ].join("\n\n"),
    );
    const draft = cloneDoc(live);
    const [first, , third] = model.getBlocks(toDocHandle(draft));
    const firstUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 6, to: 12 }, "rewrite"),
    );
    const thirdUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), third, { from: 6, to: 12 }, "rewrite"),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 201, actorTurnId: null, actorUserId: "user-a", updateData: firstUpdate },
        { id: 202, actorTurnId: null, actorUserId: "user-a", updateData: thirdUpdate },
      ],
    });

    expect(result.reviewMode).toBe("inline");
    if (result.reviewMode !== "inline") throw new Error("expected inline result");
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([["writer:1"], ["writer:2"]]);
    expect(result.operations.map((operation) => operation.sourceUpdateIds)).toEqual([[201], [202]]);
  });

  it("keeps mixed agent and writer rows in one block as separate operations", () => {
    const live = createDoc(
      "Alpha target remains with enough unchanged surrounding text for attribution.",
    );
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const agentUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 6, to: 12 }, "agent"),
    );
    const writerUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 11, to: 11 }, " writer"),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 211, actorTurnId: "turn-agent", updateData: agentUpdate },
        { id: 212, actorTurnId: null, actorUserId: "user-a", updateData: writerUpdate },
      ],
    });

    expect(result.reviewMode).toBe("inline");
    if (result.reviewMode !== "inline") throw new Error("expected inline result");
    expect(new Set(result.hunks.flatMap((hunk) => hunk.operationIds))).toEqual(
      new Set(["211", "writer:1"]),
    );
    expect(result.operations).toEqual([
      {
        operationId: "211",
        sourceUpdateIds: [211],
        actorTurnId: "turn-agent",
        kind: "agent",
        hunkCount: 1,
      },
      {
        operationId: "writer:1",
        sourceUpdateIds: [212],
        actorUserId: "user-a",
        kind: "writer",
        hunkCount: 1,
      },
    ]);
  });

  it("surfaces writer edits inside unchanged-identity blocks untouched by the agent", () => {
    const live = createDoc(
      [
        "Alpha remains unchanged with enough surrounding text for review attribution.",
        "Beta target remains with enough unchanged surrounding text for agent attribution.",
        "Gamma remains unchanged with enough surrounding text for review attribution.",
        "Delta remains unchanged with enough surrounding text for writer attribution.",
      ].join("\n\n"),
    );
    const draft = cloneDoc(live);
    const [, second, , fourth] = model.getBlocks(toDocHandle(draft));
    const agentUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), second, { from: 11, to: 11 }, " agent"),
    );
    const writerUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), fourth, { from: 5, to: 5 }, " writer"),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 241, actorTurnId: "turn-agent", updateData: agentUpdate },
        { id: 242, actorTurnId: null, actorUserId: "user-a", updateData: writerUpdate },
      ],
    });

    expect(result.reviewMode).toBe("inline");
    if (result.reviewMode !== "inline") throw new Error("expected inline result");
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([["241"], ["writer:1"]]);
    expect(result.operations).toEqual([
      {
        operationId: "241",
        sourceUpdateIds: [241],
        actorTurnId: "turn-agent",
        kind: "agent",
        hunkCount: 1,
      },
      {
        operationId: "writer:1",
        sourceUpdateIds: [242],
        actorUserId: "user-a",
        kind: "writer",
        hunkCount: 1,
      },
    ]);
  });

  it("surfaces writer deletion of an entire unchanged-identity block", () => {
    const live = createDoc(
      [
        "Alpha remains unchanged with enough surrounding text for review attribution.",
        "Beta target remains with enough unchanged surrounding text for agent attribution.",
        "Gamma remains unchanged with enough surrounding text for review attribution.",
        "Delta deleted block keeps enough text for writer deletion attribution.",
        "Epsilon remains as an anchor after the deleted writer block.",
      ].join("\n\n"),
    );
    const draft = cloneDoc(live);
    const [, second, , fourth] = model.getBlocks(toDocHandle(draft));
    const agentUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), second, { from: 11, to: 11 }, " agent"),
    );
    const writerUpdate = captureUpdate(draft, () => model.deleteBlock(toDocHandle(draft), fourth));

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 251, actorTurnId: "turn-agent", updateData: agentUpdate },
        { id: 252, actorTurnId: null, actorUserId: "user-a", updateData: writerUpdate },
      ],
    });

    expect(result.reviewMode).toBe("inline");
    if (result.reviewMode !== "inline") throw new Error("expected inline result");
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([["251"], ["writer:1"]]);
    expect(result.hunks[1]).toMatchObject({
      operationIds: ["writer:1"],
      deletedText: "Delta deleted block keeps enough text for writer deletion attribution.",
    });
    expect(result.operations).toEqual([
      {
        operationId: "251",
        sourceUpdateIds: [251],
        actorTurnId: "turn-agent",
        kind: "agent",
        hunkCount: 1,
      },
      {
        operationId: "writer:1",
        sourceUpdateIds: [252],
        actorUserId: "user-a",
        kind: "writer",
        hunkCount: 1,
      },
    ]);
  });

  it("falls back to panel mode when configured thresholds are exceeded", () => {
    const live = createDoc("A ".repeat(200));
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () =>
      model.applyTextEdit(
        toDocHandle(draft),
        first,
        { from: 0, to: model.getText(first).length },
        "B ".repeat(200),
      ),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 51, actorTurnId: "turn-rewrite", updateData: update }],
    });

    expect(result).toEqual({ reviewMode: "panel", fallbackReason: "rewrite_threshold" });
  });

  it("returns hunks for soft fallback when the active review surface is inline", () => {
    const live = createDoc("A ".repeat(200));
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () =>
      model.applyTextEdit(
        toDocHandle(draft),
        first,
        { from: 0, to: model.getText(first).length },
        "B ".repeat(200),
      ),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 54, actorTurnId: "turn-rewrite", updateData: update }],
      requestedSurface: "inline",
    });

    expect(result.reviewMode).toBe("panel");
    if (!("hunks" in result)) throw new Error("expected inline model to be present");
    expect(result.fallbackReason).toBe("rewrite_threshold");
    expect(result.hunks.length).toBeGreaterThan(0);
    expect(result.operations.map((operation) => operation.operationId)).toEqual(["54"]);
  });

  it("omits hunks for unsupported changed nodes even when the active review surface is inline", () => {
    const live = createDoc(
      "- sword item with enough surrounding list text for unsupported fallback",
    );
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 2, to: 7 }, "blade"),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 55, actorTurnId: "turn-list", updateData: update }],
      requestedSurface: "inline",
    });

    expect(result).toEqual({ reviewMode: "panel", fallbackReason: "unsupported_node_type" });
  });

  it("falls back to panel mode when hunk density is too high", () => {
    const paragraph = "Stable text around edit point.";
    const live = createDoc(
      Array.from({ length: 20 }, (_, index) => `${paragraph} ${index}`).join("\n\n"),
    );
    const draft = cloneDoc(live);
    const blocks = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () => {
      for (const block of blocks) {
        model.applyTextEdit(toDocHandle(draft), block, { from: 4, to: 4 }, "X");
      }
    });

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 52, actorTurnId: "turn-many", updateData: update }],
    });

    expect(result).toEqual({ reviewMode: "panel", fallbackReason: "hunk_density" });
  });

  it("falls back to panel mode when block churn is too high", () => {
    const live = createDoc("One\n\nTwo\n\nThree\n\nFour");
    const draft = cloneDoc(live);
    const [, two, three, four] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () => {
      model.deleteBlock(toDocHandle(draft), two);
      model.deleteBlock(toDocHandle(draft), three);
      model.deleteBlock(toDocHandle(draft), four);
    });

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 53, actorTurnId: "turn-churn", updateData: update }],
    });

    expect(result).toEqual({ reviewMode: "panel", fallbackReason: "block_churn" });
  });
});

function createDoc(markdown: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  const parsed = codec.parse(markdown);
  const root = schema.node("doc", null, parsed.blocks);
  prosemirrorToYXmlFragment(root, doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
  return doc;
}

function cloneDoc(source: Y.Doc): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 2;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
}

function captureUpdate(doc: Y.Doc, mutate: () => void): Uint8Array {
  const before = Y.encodeStateVector(doc);
  mutate();
  return Y.encodeStateAsUpdate(doc, before);
}

function firstXmlText(doc: Y.Doc): Y.XmlText {
  const [block] = model.getBlocks(toDocHandle(doc));
  for (const child of unwrapBlock(block).toArray()) {
    if (child instanceof Y.XmlText) return child;
  }
  throw new Error("expected text child");
}
