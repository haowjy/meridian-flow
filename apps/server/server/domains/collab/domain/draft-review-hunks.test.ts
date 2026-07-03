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
    expect(result.operations).toMatchObject([
      {
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
      },
    ]);
  });

  it("keeps a tiny heading plus sentence one-word change inline", () => {
    const live = createDoc("# Chapter 1\n\nThe hero lifted a sword.");
    const draft = cloneDoc(live);
    const [, paragraph] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), paragraph, { from: 18, to: 23 }, "blade"),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 11, actorTurnId: "turn-tiny-word", updateData: update }],
    });

    expect("operations" in result).toBe(true);
  });

  it("keeps a tiny heading plus sentence full-sentence rewrite inline", () => {
    const live = createDoc("# Chapter 1\n\nThe hero lifted a sword.");
    const draft = cloneDoc(live);
    const [, paragraph] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () =>
      model.applyTextEdit(
        toDocHandle(draft),
        paragraph,
        { from: 0, to: model.getText(paragraph).length },
        "A dragon arrived before dawn.",
      ),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 12, actorTurnId: "turn-tiny-rewrite", updateData: update }],
    });

    expect("operations" in result).toBe(true);
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
    expect(result.operations).toMatchObject([
      {
        operationId: "223",
        contribution: "removed",
        classification: "removal",
        beforeExcerpt: "sword",
        sourceUpdateIds: [223],
        rejectSourceUpdateIds: [223],
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(result.hunks).toEqual([
      expect.objectContaining({ operationIds: ["writer:233-c0509a487a"], deletedText: "sword" }),
    ]);
    expect(result.operations).toMatchObject([
      {
        operationId: "writer:233-c0509a487a",
        contribution: "removed",
        classification: "removal",
        beforeExcerpt: "sword",
        sourceUpdateIds: [233],
        rejectSourceUpdateIds: [233],
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([["171"], ["171"]]);
    expect(result.operations).toMatchObject([
      {
        operationId: "171",
        contribution: "removed",
        classification: "removal",
        beforeExcerpt: "target",
        sourceUpdateIds: [171],
        rejectSourceUpdateIds: [171],
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(result.hunks[0].operationIds).toEqual(["41"]);
    expect(result.operations).toMatchObject([
      {
        operationId: "41",
        contribution: "added",
        classification: "addition",
        afterExcerpt: "writer",
        sourceUpdateIds: [41],
        rejectSourceUpdateIds: [41],
        kind: "agent",
        hunkCount: 1,
      },
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(new Set(result.hunks.flatMap((hunk) => hunk.operationIds))).toEqual(
      new Set(["writer:181-3108fb3cf6"]),
    );
    expect(result.operations).toMatchObject([
      {
        operationId: "writer:181-3108fb3cf6",
        contribution: "added",
        classification: "addition",
        afterExcerpt: "writer careful",
        sourceUpdateIds: [181, 182],
        rejectSourceUpdateIds: [181, 182],
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([
      ["writer:191-1a28c631e9"],
      ["writer:191-1a28c631e9"],
    ]);
    expect(result.operations).toMatchObject([
      {
        operationId: "writer:191-1a28c631e9",
        contribution: "rewrote",
        classification: "rename",
        beforeExcerpt: "target",
        afterExcerpt: "rewrite",
        sourceUpdateIds: [191, 192],
        rejectSourceUpdateIds: [191, 192],
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([
      ["writer:201-43974ed740"],
      ["writer:202-c17edaae86"],
    ]);
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(new Set(result.hunks.flatMap((hunk) => hunk.operationIds))).toEqual(
      new Set(["211", "writer:212-fa2b7af0a8"]),
    );
    expect(result.operations).toMatchObject([
      {
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
      },
      {
        operationId: "writer:212-fa2b7af0a8",
        contribution: "added",
        classification: "rewrite",
        beforeExcerpt: "target",
        afterExcerpt: "agent writer",
        sourceUpdateIds: [212],
        rejectSourceUpdateIds: [211, 212],
        actorUserId: "user-a",
        kind: "writer",
        hunkCount: 1,
      },
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
    expect(result.operations).toMatchObject([
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
    const live = createDoc(
      "Alpha tail text keeps hunk density below the fallback cutoff for mixed insertion.",
    );
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
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([
      ["241"],
      ["writer:242-1406369760"],
    ]);
    expect(result.operations).toMatchObject([
      {
        operationId: "241",
        contribution: "added",
        classification: "addition",
        afterExcerpt: "agent",
        sourceUpdateIds: [241],
        rejectSourceUpdateIds: [241],
        actorTurnId: "turn-agent",
        kind: "agent",
        hunkCount: 1,
      },
      {
        operationId: "writer:242-1406369760",
        contribution: "added",
        classification: "addition",
        afterExcerpt: "writer",
        sourceUpdateIds: [242],
        rejectSourceUpdateIds: [242],
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

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([
      ["251"],
      ["writer:252-d6e5a20b30"],
    ]);
    expect(result.hunks[1]).toMatchObject({
      operationIds: ["writer:252-d6e5a20b30"],
      deletedText: "Delta deleted block keeps enough text for writer deletion attribution.",
    });
    expect(result.operations).toMatchObject([
      {
        operationId: "251",
        contribution: "added",
        classification: "addition",
        afterExcerpt: "agent",
        sourceUpdateIds: [251],
        rejectSourceUpdateIds: [251],
        actorTurnId: "turn-agent",
        kind: "agent",
        hunkCount: 1,
      },
      {
        operationId: "writer:252-d6e5a20b30",
        contribution: "removed",
        classification: "removal",
        beforeExcerpt: "Delta deleted block keeps enough text for writer deletion…",
        sourceUpdateIds: [252],
        rejectSourceUpdateIds: [252],
        actorUserId: "user-a",
        kind: "writer",
        hunkCount: 1,
      },
    ]);
  });

  it("keeps a full rewrite of a small one-paragraph document inline", () => {
    const live = createDoc("The old paragraph is short.");
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () =>
      model.applyTextEdit(
        toDocHandle(draft),
        first,
        { from: 0, to: model.getText(first).length },
        "A completely different paragraph replaces it.",
      ),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 51, actorTurnId: "turn-rewrite", updateData: update }],
    });

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");

    expect(result.hunks.length).toBeGreaterThan(0);
    expect(result.operations.map((operation) => operation.operationId)).toEqual(["51"]);
  });

  it("omits hunks for unsupported changed nodes", () => {
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
    });

    expect(result).toEqual({ panelFallback: true });
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

    expect(result.hunks.some((hunk) => hunk.deletedText === "Two paragraph.")).toBe(true);
    expect(result.hunks.some((hunk) => !hunk.deletedText && hunk.operationIds.length > 0)).toBe(
      true,
    );
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
