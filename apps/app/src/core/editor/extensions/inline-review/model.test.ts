/**
 * The server's hunks as the review editor reads them: a hunk no operation owns
 * is still painted, focused and found by a stand-in key, and its flag survives.
 */
import type { ReviewHunk } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { buildInlineReviewModel, isUnattributedHunkKey, unattributedHunkKey } from "./model";

function anchor(): string {
  const doc = new Y.Doc();
  const text = doc.getText("t");
  text.insert(0, "Alpha");
  const bytes = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, 0));
  return Buffer.from(bytes).toString("base64");
}

const hunk = (overrides: Partial<ReviewHunk> & { hunkId: string }): ReviewHunk =>
  ({
    kind: "text",
    operationIds: [],
    anchor: { relStart: anchor(), relEnd: anchor() },
    spans: [],
    ...overrides,
  }) as ReviewHunk;

describe("buildInlineReviewModel", () => {
  it("keeps an unclassified hunk with no operation, keyed so it can be focused", () => {
    const { hunks } = buildInlineReviewModel({
      draftRevisionToken: "t",
      operations: [],
      hunks: [hunk({ hunkId: "h", unclassified: true, deletedText: "Alpha", deletedSpans: [] })],
    });
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      hunkId: "h",
      unclassified: true,
      operationIds: [unattributedHunkKey("h")],
      deletedText: "Alpha",
      deletedSpans: [],
    });
    expect(isUnattributedHunkKey(hunks[0].operationIds[0])).toBe(true);
  });

  it("leaves an owned hunk's operations alone, and carries the flag when its operations are partial", () => {
    const { hunks } = buildInlineReviewModel({
      draftRevisionToken: "t",
      operations: [],
      hunks: [hunk({ hunkId: "h", operationIds: ["7"], unclassified: true })],
    });
    expect(hunks[0]).toMatchObject({ operationIds: ["7"], unclassified: true });
  });

  it("does not flag an ordinary hunk", () => {
    const { hunks } = buildInlineReviewModel({
      draftRevisionToken: "t",
      operations: [],
      hunks: [hunk({ hunkId: "h", operationIds: ["7"] })],
    });
    expect(hunks[0].unclassified).toBeUndefined();
  });
});
