/** Work draft projection preserves the one-active-branch-per-document contract. */
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";
import { groupDraftsByDocument } from "./useWorkDrafts";

function item(draftId: string, updatedAt: string): ThreadDraftListItem {
  return {
    draftId,
    documentId: "document-1",
    documentName: "Chapter one",
    contextPath: "chapters/one.md",
    status: "active",
    lastActorTurnId: null,
    actorThreads: [],
    updatedAt,
    wordsAdded: 1,
    wordsRemoved: 0,
  };
}

describe("groupDraftsByDocument", () => {
  it("uses deterministic recency when malformed input repeats a document", () => {
    const groups = groupDraftsByDocument([
      item("older", "2026-10-01T00:00:00.000Z"),
      item("newer", "2026-10-02T00:00:00.000Z"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.documentId).toBe("document-1");
    expect(groups[0]?.draft.draftId).toBe("newer");
  });
});
