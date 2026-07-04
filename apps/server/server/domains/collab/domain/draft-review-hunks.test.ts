/** Unit coverage for draft live-vs-draft hunk extraction and attribution. */
import { toDocHandle, unwrapBlock, yProsemirrorModel } from "@meridian/agent-edit";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema });
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
        rejectSourceUpdateIds: [10],
        actorTurnId: "turn-a",
        kind: "agent",
        hunkCount: 1,
      }),
    ]);
  });

  describe("inline review eligibility", () => {
    it.each([
      {
        name: "tiny heading one-word change",
        markdown: "# Chapter 1\n\nThe hero lifted a sword.",
        blockIndex: 1,
        range: { from: 18, to: 23 },
        replacement: "blade",
        updateId: 11,
        actorTurnId: "turn-tiny-word",
      },
      {
        name: "small one-paragraph full rewrite",
        markdown: "The old paragraph is short.",
        blockIndex: 0,
        range: null,
        replacement: "A completely different paragraph replaces it.",
        updateId: 51,
        actorTurnId: "turn-rewrite",
      },
    ])("$name stays inline", ({
      markdown,
      blockIndex,
      range,
      replacement,
      updateId,
      actorTurnId,
    }) => {
      const live = createDoc(markdown);
      const draft = cloneDoc(live);
      const block = model.getBlocks(toDocHandle(draft))[blockIndex];
      const update = captureUpdate(draft, () => {
        const editRange = range ?? { from: 0, to: model.getText(block).length };
        model.applyTextEdit(toDocHandle(draft), block, editRange, replacement);
      });

      const result = computeDraftReviewHunks({
        liveDoc: live,
        draftDoc: draft,
        model,
        draftUpdates: [{ id: updateId, actorTurnId, updateData: update }],
      });

      expect("operations" in result).toBe(true);
      if (!("operations" in result)) throw new Error("expected inline result");
      expect(result.hunks.length).toBeGreaterThan(0);
    });
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(result.hunks).toEqual([
      expect.objectContaining({ operationIds: ["223"], deletedText: "sword" }),
    ]);
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "223",
        contribution: "removed",
        classification: "removal",
        beforeExcerpt: "sword",
        sourceUpdateIds: [223],
        rejectSourceUpdateIds: [223],
        actorTurnId: "turn-second-delete",
        kind: "agent",
        hunkCount: 1,
      }),
    ]);
  });

  it("attributes delete undo writer re-delete to the writer row", () => {
    const live = createDoc(
      "Alpha sword remains with enough unchanged surrounding text for resurrection attribution.",
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    const writerOperationId = writerOperationIdForRow(result.operations, 233);
    expect(result.hunks).toEqual([
      expect.objectContaining({ operationIds: [writerOperationId], deletedText: "sword" }),
    ]);
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: writerOperationId,
        contribution: "removed",
        classification: "removal",
        beforeExcerpt: "sword",
        sourceUpdateIds: [233],
        rejectSourceUpdateIds: [233],
        actorUserId: "user-a",
        kind: "writer",
        hunkCount: 1,
      }),
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
        rejectSourceUpdateIds: [171],
        actorTurnId: "turn-two-deletions",
        kind: "agent",
        hunkCount: 2,
      }),
    ]);
  });

  it("maps a coalesced visual hunk spanning two rows to both operations", () => {
    const live = createDoc(
      "Alpha. Tail text keeps the rewrite ratio low and the hunk density manageable.",
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0].operationIds).toEqual(["31", "32"]);
    expect(result.operations.map((operation) => operation.operationId)).toEqual(["31", "32"]);
  });

  it("treats rows without actor turn or actor user as unattributed agent operations", () => {
    const live = createDoc("Alpha. Tail text for an unattributed edit.");
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(result.hunks[0].operationIds).toEqual(["41"]);
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "41",
        contribution: "added",
        classification: "addition",
        afterExcerpt: "writer",
        sourceUpdateIds: [41],
        rejectSourceUpdateIds: [41],
        kind: "agent",
        hunkCount: 1,
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
        rejectSourceUpdateIds: [181, 182],
        actorUserId: "user-a",
        kind: "writer",
        hunkCount: result.hunks.length,
      }),
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    const writerOperationId = writerOperationIdForRow(result.operations, 191);
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([
      [writerOperationId],
      [writerOperationId],
    ]);
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: writerOperationId,
        contribution: "rewrote",
        classification: "rename",
        beforeExcerpt: "target",
        afterExcerpt: "rewrite",
        sourceUpdateIds: [191, 192],
        rejectSourceUpdateIds: [191, 192],
        actorUserId: "user-a",
        kind: "writer",
        hunkCount: 2,
      }),
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    const firstWriterId = writerOperationIdForRow(result.operations, 201);
    const secondWriterId = writerOperationIdForRow(result.operations, 202);
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([
      [firstWriterId],
      [secondWriterId],
    ]);
    expect(result.operations.map((operation) => operation.sourceUpdateIds)).toEqual([[201], [202]]);
    expect(result.operations.every((operation) => operation.kind === "writer")).toBe(true);
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
        rejectSourceUpdateIds: [211, 212],
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
        rejectSourceUpdateIds: [211, 212],
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

  it("truncates before and after excerpts for rewrites", () => {
    const live = createDoc(
      "The exhausted cultivator crossed the moonlit bridge before the bell rang softly.",
    );
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () =>
      model.applyTextEdit(
        toDocHandle(draft),
        first,
        { from: 0, to: model.getText(first).length },
        "A victorious swordsman strode through the crimson courtyard while drums thundered.",
      ),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 262, actorTurnId: "turn-rewrite", updateData: update }],
    });

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(result.operations[0]).toMatchObject({
      classification: "rewrite",
      beforeExcerpt: "The exhausted cultivator crossed the moonlit bridge before…",
      afterExcerpt: "A victorious swordsman strode through the crimson courtyard…",
    });
  });

  it("falls back to rewrite classification when repeated rename pairs differ", () => {
    const live = createDoc(
      [
        "Chen raised the sword with enough surrounding text for review.",
        "Wang crossed the bridge with enough surrounding text for review.",
      ].join("\n\n"),
    );
    const draft = cloneDoc(live);
    const [first, second] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () => {
      model.applyTextEdit(toDocHandle(draft), first, { from: 0, to: 4 }, "Li Wei");
      model.applyTextEdit(toDocHandle(draft), second, { from: 0, to: 4 }, "Zhao");
    });

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 263, actorTurnId: "turn-mixed-rename", updateData: update }],
    });

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(result.operations[0]).toMatchObject({ classification: "rewrite", hunkCount: 2 });
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
        rejectSourceUpdateIds: [241],
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
        rejectSourceUpdateIds: [242],
        actorUserId: "user-a",
        kind: "writer",
        hunkCount: 1,
      }),
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    const writerOperationId = writerOperationIdForRow(result.operations, 252);
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([["251"], [writerOperationId]]);
    expect(result.hunks[1]).toMatchObject({
      operationIds: [writerOperationId],
      deletedText: "Delta deleted block keeps enough text for writer deletion attribution.",
    });
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "251",
        contribution: "added",
        classification: "addition",
        afterExcerpt: "agent",
        sourceUpdateIds: [251],
        rejectSourceUpdateIds: [251],
        actorTurnId: "turn-agent",
        kind: "agent",
        hunkCount: 1,
      }),
      expect.objectContaining({
        operationId: writerOperationId,
        contribution: "removed",
        classification: "removal",
        beforeExcerpt: "Delta deleted block keeps enough text for writer deletion…",
        sourceUpdateIds: [252],
        rejectSourceUpdateIds: [252],
        actorUserId: "user-a",
        kind: "writer",
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

  it("emits a block hunk for horizontal rule insertions", () => {
    const live = createDoc("Alpha.\n\nOmega.");
    const draft = cloneDoc(live);
    const [alpha] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () =>
      model.insertBlocks(toDocHandle(draft), alpha, codec.parse("---")),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 56, actorTurnId: "turn-hr", updateData: update }],
    });

    expect(result.hunks).toEqual([
      expect.objectContaining({
        kind: "block",
        operationIds: ["56"],
        insertedBlock: { type: "horizontal_rule", display: "───" },
      }),
    ]);
    expect(result.operations[0]).toMatchObject({
      operationId: "56",
      contribution: "added",
      classification: "addition",
      afterExcerpt: "───",
    });
  });

  it("emits a block hunk for inserted empty paragraphs", () => {
    const live = createDoc("Alpha.");
    const draft = cloneDoc(live);
    const [alpha] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () =>
      model.insertBlocks(toDocHandle(draft), alpha, codec.parse("")),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 61, actorTurnId: "turn-empty-paragraph", updateData: update }],
    });

    expect(result.hunks).toEqual([
      expect.objectContaining({
        kind: "block",
        operationIds: ["61"],
        insertedBlock: { type: "paragraph", display: "Paragraph" },
      }),
    ]);
    expect(result.operations[0]).toMatchObject({
      operationId: "61",
      contribution: "added",
      classification: "addition",
      afterExcerpt: "Paragraph",
    });
  });

  it("emits a block hunk for inserted empty headings", () => {
    const live = createDoc("Alpha.");
    const draft = cloneDoc(live);
    const [alpha] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () =>
      model.insertBlocks(toDocHandle(draft), alpha, codec.parse("# ")),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 62, actorTurnId: "turn-empty-heading", updateData: update }],
    });

    expect(result.hunks).toEqual([
      expect.objectContaining({
        kind: "block",
        operationIds: ["62"],
        insertedBlock: { type: "heading", display: "Heading" },
      }),
    ]);
    expect(result.operations[0]).toMatchObject({
      operationId: "62",
      contribution: "added",
      classification: "addition",
      afterExcerpt: "Heading",
    });
  });

  it("emits a block hunk for a rule becoming a blank paragraph", () => {
    const live = createDoc("---");
    const draft = cloneDoc(live);
    const [rule] = model.getBlocks(toDocHandle(draft));
    const deleteRule = captureUpdate(draft, () => model.deleteBlock(toDocHandle(draft), rule));
    const insertBlank = captureUpdate(draft, () =>
      model.insertBlocks(toDocHandle(draft), null, codec.parse("")),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 63, actorTurnId: "turn-rule-delete", updateData: deleteRule },
        { id: 64, actorTurnId: "turn-blank-insert", updateData: insertBlank },
      ],
    });

    expect(result.hunks).toEqual([
      expect.objectContaining({
        kind: "block",
        operationIds: ["64"],
        insertedBlock: { type: "paragraph", display: "Paragraph" },
      }),
    ]);
  });

  it("anchors a deletion that leaves an empty paragraph tail", () => {
    const live = createDoc("Alpha.");
    const draft = cloneDoc(live);
    const [alpha] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), alpha, { from: 0, to: 6 }, ""),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 65, actorTurnId: "turn-empty-tail", updateData: update }],
    });

    expect(result.hunks).toEqual([
      expect.objectContaining({
        kind: "text",
        operationIds: ["65"],
        deletedText: "Alpha.",
      }),
    ]);
  });

  it("emits a block hunk for horizontal rule deletions", () => {
    const live = createDoc("Alpha.\n\n---\n\nOmega.");
    const draft = cloneDoc(live);
    const [, rule] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () => model.deleteBlock(toDocHandle(draft), rule));

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 57, actorTurnId: "turn-hr-delete", updateData: update }],
    });

    expect(result.hunks).toEqual([
      expect.objectContaining({
        kind: "block",
        operationIds: ["57"],
        deletedBlock: { type: "horizontal_rule", display: "───" },
      }),
    ]);
    expect(result.operations[0]).toMatchObject({
      operationId: "57",
      contribution: "removed",
      classification: "removal",
      beforeExcerpt: "───",
    });
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

function firstXmlText(doc: Y.Doc): Y.XmlText {
  const [block] = model.getBlocks(toDocHandle(doc));
  for (const child of unwrapBlock(block).toArray()) {
    if (child instanceof Y.XmlText) return child;
  }
  throw new Error("expected text child");
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
