/** Real-Yjs source identity and independent class replay regressions. */
import { toDocHandle } from "@meridian/agent-edit/integration";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import { captureUpdate, cloneDoc, createDoc, model } from "./draft-review-test-fixture.js";

describe("writer review classes", () => {
  it.each([0, 1, 2])("keeps independent writer typing separate in block %i", (blockIndex) => {
    const live = createDoc(
      "Alpha base with plenty of unchanged words around the edits.\n\nBeta base with plenty of unchanged words.\n\nGamma base with plenty of unchanged words.",
    );
    const draft = cloneDoc(live);
    const edit = (client: number, block: number, at: number, text: string) => {
      draft.clientID = client;
      return captureUpdate(draft, () =>
        model.applyTextEdit(
          toDocHandle(draft),
          model.getBlocks(toDocHandle(draft))[block],
          { from: at, to: at },
          text,
        ),
      );
    };
    const rows = [
      { id: 10, actorTurnId: "ai", updateData: edit(10, 0, 6, "proposed ") },
      { id: 11, actorUserId: "writer", actorTurnId: null, updateData: edit(11, 0, 10, "inside ") },
      {
        id: 12,
        actorUserId: "writer",
        actorTurnId: null,
        updateData: edit(
          12,
          blockIndex,
          model.getText(model.getBlocks(toDocHandle(draft))[blockIndex]).length,
          " Independent",
        ),
      },
    ];
    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: rows,
    });
    const classes = [...new Set(result.operations.map((op) => op.closureClassId))];
    expect(classes).toHaveLength(2);
    for (const id of classes) {
      const selected = new Set(
        result.operations
          .filter((op) => op.closureClassId === id)
          .flatMap((op) => op.closureUpdateIds),
      );
      const replay = cloneDoc(live);
      for (const row of rows)
        if (selected.has(row.id as never)) Y.applyUpdate(replay, row.updateData);
      expect(replay.store.pendingStructs).toBeNull();
      expect(replay.store.pendingDs).toBeNull();
      const text = model
        .getBlocks(toDocHandle(replay))
        .map((block) => model.getText(block))
        .join("\n\n");
      expect(text.includes("Independent")).toBe(selected.has(12 as never));
      expect(text.includes("propinside osed")).toBe(selected.has(10 as never));
      replay.destroy();
    }
    live.destroy();
    draft.destroy();
  });
  it("keeps a same-client word typing burst in one writer change", () => {
    const live = createDoc("Alpha base.");
    const draft = cloneDoc(live);
    const rows = [..."word"].map((letter, index) => ({
      id: index + 10,
      actorUserId: "writer",
      actorTurnId: null,
      updateData: captureUpdate(draft, () =>
        model.applyTextEdit(
          toDocHandle(draft),
          model.getBlocks(toDocHandle(draft))[0],
          { from: index, to: index },
          letter,
        ),
      ),
    }));
    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: rows,
    });
    expect(new Set(result.operations.map((op) => op.closureClassId)).size).toBe(1);
    expect(result.operations.every((op) => op.kind === "writer")).toBe(true);
    live.destroy();
    draft.destroy();
  });
});
