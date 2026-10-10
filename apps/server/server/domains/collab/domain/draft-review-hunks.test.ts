/** Real-Yjs draft review behavioral coverage. */
import { toDocHandle } from "@meridian/agent-edit/integration";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { alignBlocks } from "./document-difference.js";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import { captureUpdate, cloneDoc, codec, createDoc, model } from "./draft-review-test-fixture.js";

describe("draft review hunks", () => {
  it("uses a generic image label rather than exposing a stored source identity", () => {
    const live = createDoc("Anchor.");
    const draft = cloneDoc(live);
    const image = new Y.XmlElement("image");
    image.setAttribute("src", "asset:00000000-0000-4000-8000-000000000712");
    const update = captureUpdate(draft, () => {
      const fragment = draft.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
      fragment.insert(fragment.length, [image]);
    });
    try {
      const review = computeDraftReviewHunks({
        liveDoc: live,
        draftDoc: draft,
        model,
        draftUpdates: [{ id: 60, actorTurnId: "turn-image", updateData: update }],
      });
      expect(review.hunks).toContainEqual(
        expect.objectContaining({
          kind: "block",
          insertedBlock: { type: "image", display: "Image" },
        }),
      );
      expect(JSON.stringify(review)).not.toContain("asset:");
    } finally {
      draft.destroy();
      live.destroy();
    }
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
