/** Real-Yjs draft review behavioral coverage. */
import { toDocHandle } from "@meridian/agent-edit/integration";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { alignBlocks, computeDraftReviewHunks } from "./draft-review-hunks.js";
import { computeDraftReviewOperations } from "./draft-review-operations.js";
import {
  captureUpdate,
  cloneDoc,
  codec,
  createDoc,
  model,
  spanTextRange,
} from "./draft-review-test-fixture.js";

describe("draft review hunks", () => {
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
        closureUpdateIds: [10],
        actorTurnId: "turn-a",
        kind: "agent",
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

describe("block alignment", () => {
  it("aligns one changed ID in 8,000 blocks within half a second", () => {
    const live = Array.from({ length: 8000 }, (_, i) => ({ id: String(i), text: "unchanged" }));
    const draft = live.map((block) => ({ ...block }));
    draft[4000].id = "changed";
    const start = performance.now();
    const result = alignBlocks(live, draft);
    expect(result.filter((entry) => entry.kind !== "equal").map((entry) => entry.kind)).toEqual([
      "delete",
      "insert",
    ]);
    expect(performance.now() - start).toBeLessThan(500);
  });
  it("retains the first duplicate surviving anchor under the LCS tie rule", () => {
    const result = alignBlocks(
      [{ id: "a" }, { id: "b" }],
      [
        { id: "b", text: "first" },
        { id: "b", text: "last" },
      ],
    );
    expect(result.map((entry) => entry.kind)).toEqual(["delete", "equal", "insert"]);
    expect(result[1]).toMatchObject({ draft: { text: "first" } });
  });
});
