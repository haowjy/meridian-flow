/** Unit coverage for draft live-vs-draft hunk extraction and attribution. */
import { toDocHandle, yProsemirrorModel } from "@meridian/agent-edit/integration";
import { mdxCodec, unresolvedAssetPathResolver } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver });
const model = yProsemirrorModel(schema);

const WRITER_OPERATION_ID = /^writer:\d+-[a-f0-9]+$/;

describe("draft review hunk model", () => {
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

    expect(result).toHaveProperty("operations");
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]).toMatchObject({ operationIds: ["10"], deletedText: "sword" });
    expect(result.hunks[0].anchor.relStart).toEqual(expect.any(String));
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "10",
        contribution: "rewrote",
        classification: "rewrite",
        beforeExcerpt: "sword",
        afterExcerpt: "blade",
        sourceUpdateIds: [10],
        discardUpdateIds: [10],
        actorTurnId: "turn-a",
        kind: "agent",
        hunkCount: 1,
      }),
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(result.hunks).toEqual([
      expect.objectContaining({ operationIds: ["21"], deletedText: "sword " }),
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([["171"], ["171"]]);
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "171",
        contribution: "removed",
        classification: "removal",
        beforeExcerpt: "target",
        sourceUpdateIds: [171],
        discardUpdateIds: [171],
        actorTurnId: "turn-two-deletions",
        kind: "agent",
        hunkCount: 2,
      }),
    ]);
  });

  it("clusters writer rows in the same block into one writer operation", () => {
    const live = createDoc("Alpha. Tail text for a writer edit cluster.");
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    const writerOperationId = writerOperationIdForRow(result.operations, 181);
    expect(new Set(result.hunks.flatMap((hunk) => hunk.operationIds))).toEqual(
      new Set([writerOperationId]),
    );
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: writerOperationId,
        contribution: "added",
        classification: "addition",
        afterExcerpt: "writer careful",
        sourceUpdateIds: [181, 182],
        discardUpdateIds: [181, 182],
        actorUserId: "user-a",
        kind: "writer",
        hunkCount: result.hunks.length,
      }),
    ]);
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    const writerOperationId = writerOperationIdForRow(result.operations, 212);
    expect(new Set(result.hunks.flatMap((hunk) => hunk.operationIds))).toEqual(
      new Set(["211", writerOperationId]),
    );
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "211",
        contribution: "rewrote",
        classification: "rewrite",
        beforeExcerpt: "target",
        afterExcerpt: "agent writer",
        sourceUpdateIds: [211],
        discardUpdateIds: [211, 212],
        actorTurnId: "turn-agent",
        kind: "agent",
        hunkCount: 1,
      }),
      expect.objectContaining({
        operationId: writerOperationId,
        contribution: "added",
        classification: "rewrite",
        beforeExcerpt: "target",
        afterExcerpt: "agent writer",
        sourceUpdateIds: [212],
        discardUpdateIds: [211, 212],
        actorUserId: "user-a",
        kind: "writer",
        hunkCount: 1,
      }),
    ]);
  });

  it("classifies a repeated before-after pair across three regions as a rename", () => {
    const live = createDoc(
      [
        "Chen raised the sword with enough surrounding text for review.",
        "Chen crossed the bridge with enough surrounding text for review.",
        "Chen opened the gate with enough surrounding text for review.",
      ].join("\n\n"),
    );
    const draft = cloneDoc(live);
    const blocks = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () => {
      for (const block of blocks) {
        model.applyTextEdit(toDocHandle(draft), block, { from: 0, to: 4 }, "Li Wei");
      }
    });

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 261, actorTurnId: "turn-ai-7", updateData: update }],
    });

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "261",
        actorTurnId: "turn-ai-7",
        classification: "rename",
        beforeExcerpt: "Chen",
        afterExcerpt: "Li Wei",
        hunkCount: 3,
      }),
    ]);
  });

  it("emits ordered inserted sub-spans remapped to stable writer operation ids", () => {
    const live = createDoc("Alpha tail text for mixed insertion span ordering.");
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const agentUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 6, to: 6 }, "green text"),
    );
    const writerUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 12, to: 12 }, "gold "),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 264, actorTurnId: "turn-agent", updateData: agentUpdate },
        { id: 265, actorTurnId: null, actorUserId: "user-a", updateData: writerUpdate },
      ],
    });

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    const [hunk] = result.hunks;
    const writerOperation = result.operations.find((operation) => operation.kind === "writer");
    expect(writerOperation?.operationId).toMatch(/^writer:265-/);
    expect(hunk.kind).toBe("text");
    if (hunk.kind !== "text") throw new Error("expected text hunk");
    expect(hunk.spans.map((span) => span.operationId)).toContain(writerOperation?.operationId);

    const positions = hunk.spans.map((span) => spanTextRange(draft, span));
    expect(
      positions.every((position, index) => index === 0 || positions[index - 1].to <= position.from),
    ).toBe(true);
    expect(positions.reduce((sum, position) => sum + position.to - position.from, 0)).toBe(
      "green gold text".length,
    );
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    const writerOperationId = writerOperationIdForRow(result.operations, 242);
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([["241"], [writerOperationId]]);
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "241",
        contribution: "added",
        classification: "addition",
        afterExcerpt: "agent",
        sourceUpdateIds: [241],
        discardUpdateIds: [241],
        actorTurnId: "turn-agent",
        kind: "agent",
        hunkCount: 1,
      }),
      expect.objectContaining({
        operationId: writerOperationId,
        contribution: "added",
        classification: "addition",
        afterExcerpt: "writer",
        sourceUpdateIds: [242],
        discardUpdateIds: [242],
        actorUserId: "user-a",
        kind: "writer",
        hunkCount: 1,
      }),
    ]);
  });

  it("drops opposite block delete/insert pairs from per-operation reject inverses", () => {
    const live = createDoc(
      [
        "Alpha remains unchanged with enough surrounding text for review attribution.",
        "- Placeholder outline beat one should be cut.",
        "- Placeholder outline beat two should be cut.",
        "Omega remains as an anchor after the restored writer block.",
      ].join("\n\n"),
    );
    const draft = cloneDoc(live);
    const [alpha, list] = model.getBlocks(toDocHandle(draft));
    const rewrite = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), alpha, { from: 0, to: 5 }, "Beta"),
    );
    const deleteList = captureUpdate(draft, () => model.deleteBlock(toDocHandle(draft), list));
    const rejectInverseInsert = captureUpdate(draft, () =>
      model.insertBlocks(
        toDocHandle(draft),
        alpha,
        codec.parse(
          "- Placeholder outline beat one should be cut.\n- Placeholder outline beat two should be cut.",
        ),
      ),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 266, actorTurnId: "turn-rewrite", updateData: rewrite },
        { id: 267, actorTurnId: "turn-delete-list", updateData: deleteList },
        { id: 268, actorTurnId: null, actorUserId: "user-a", updateData: rejectInverseInsert },
      ],
    });

    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]).toMatchObject({ kind: "text", operationIds: ["266"] });
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "266",
        contribution: "rewrote",
        classification: "rewrite",
        hunkCount: 1,
      }),
    ]);
  });

  it("emits a block replace hunk for list edits", () => {
    const live = createDoc(
      "- sword item with enough surrounding list text for block hunk attribution",
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
    });

    expect(result.hunks).toEqual([
      expect.objectContaining({
        kind: "block",
        operationIds: ["55"],
        deletedBlock: {
          type: "bullet_list",
          display: "sword item with enough surrounding list text for block hunk attribution",
        },
        insertedBlock: {
          type: "bullet_list",
          display: "swbladetem with enough surrounding list text for block hunk attribution",
        },
      }),
    ]);
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "55",
        contribution: "rewrote",
        classification: "rewrite",
        hunkCount: 1,
      }),
    ]);
  });

  it("allows text and block hunks to coexist", () => {
    const live = createDoc("Alpha sword.\n\nOmega.");
    const draft = cloneDoc(live);
    const [alpha] = model.getBlocks(toDocHandle(draft));
    const textUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), alpha, { from: 6, to: 11 }, "blade"),
    );
    const ruleUpdate = captureUpdate(draft, () =>
      model.insertBlocks(toDocHandle(draft), alpha, codec.parse("---")),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 58, actorTurnId: "turn-text", updateData: textUpdate },
        { id: 59, actorTurnId: "turn-block", updateData: ruleUpdate },
      ],
    });

    expect(result.hunks.map((hunk) => hunk.kind)).toEqual(["text", "block"]);
    expect(result.hunks[0]).toMatchObject({ kind: "text", operationIds: ["58"] });
    expect(result.hunks[1]).toMatchObject({
      kind: "block",
      operationIds: ["59"],
      insertedBlock: { type: "horizontal_rule", display: "───" },
    });
  });

  it("keeps paragraph moves inline as delete and insert hunks", () => {
    const live = createDoc("One paragraph.\n\nTwo paragraph.\n\nThree paragraph.");
    const draft = cloneDoc(live);
    const [, two, three] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () => {
      model.deleteBlock(toDocHandle(draft), two);
      model.insertBlocks(toDocHandle(draft), three, codec.parse("Two paragraph."));
    });

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 53, actorTurnId: "turn-move", updateData: update }],
    });

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");

    expect(
      result.hunks.some((hunk) => hunk.kind === "text" && hunk.deletedText === "Two paragraph."),
    ).toBe(true);
    expect(
      result.hunks.some(
        (hunk) => hunk.kind === "text" && !hunk.deletedText && hunk.operationIds.length > 0,
      ),
    ).toBe(true);
  });
});

function writerOperationIdForRow(
  operations: readonly { operationId: string; kind: string }[],
  rowId: number,
): string {
  const match = operations.find(
    (operation) =>
      operation.kind === "writer" && new RegExp(`^writer:${rowId}-`).test(operation.operationId),
  );
  expect(match?.operationId).toMatch(WRITER_OPERATION_ID);
  if (!match) throw new Error(`missing writer operation for row ${rowId}`);
  return match.operationId;
}

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

function spanTextRange(
  doc: Y.Doc,
  span: { anchorFrom: string; anchorTo: string },
): { from: number; to: number } {
  const from = Y.createAbsolutePositionFromRelativePosition(
    Y.decodeRelativePosition(Buffer.from(span.anchorFrom, "base64")),
    doc,
  );
  const to = Y.createAbsolutePositionFromRelativePosition(
    Y.decodeRelativePosition(Buffer.from(span.anchorTo, "base64")),
    doc,
  );
  if (!from || !to || from.type !== to.type) throw new Error("expected span in one text node");
  return { from: from.index, to: to.index };
}
