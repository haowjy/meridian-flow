/** Same-document draft ordering and nearest-neighbor progression. */
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";
import { nearestRemainingDraftId, orderedActiveDrafts } from "./DraftReviewProvider";

describe("draft review progression", () => {
  it("orders active drafts oldest-first with a stable id tiebreak", () => {
    expect(
      orderedActiveDrafts([
        draft("draft-c", "2026-07-25T12:01:00.000Z"),
        draft("draft-b", "2026-07-25T12:00:00.000Z"),
        draft("draft-a", "2026-07-25T12:00:00.000Z"),
        draft("closed", "2026-07-25T11:00:00.000Z", "closed"),
      ]).map((item) => item.draftId),
    ).toEqual(["draft-a", "draft-b", "draft-c"]);
  });

  it("advances at the same index, then falls back to the previous draft", () => {
    const prior = [
      draft("draft-a", "2026-07-25T12:00:00.000Z"),
      draft("draft-b", "2026-07-25T12:01:00.000Z"),
      draft("draft-c", "2026-07-25T12:02:00.000Z"),
    ];

    expect(nearestRemainingDraftId(prior, "draft-b", [prior[0], prior[2]])).toBe("draft-c");
    expect(nearestRemainingDraftId(prior, "draft-c", [prior[0], prior[1]])).toBe("draft-b");
    expect(nearestRemainingDraftId(prior, "draft-a", [])).toBeNull();
  });
});

function draft(
  draftId: string,
  updatedAt: string,
  status: ThreadDraftListItem["status"] = "active",
): ThreadDraftListItem {
  return {
    draftId,
    documentId: "document-1",
    documentName: "Chapter 1",
    contextPath: "work://manuscript/chapter-1.md",
    status,
    lastActorTurnId: null,
    updatedAt,
    appliedAt: null,
    discardedAt: null,
    wordsAdded: 1,
    wordsRemoved: 0,
  };
}
