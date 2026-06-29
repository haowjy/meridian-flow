import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";

import { groupDraftsByDocument } from "./useThreadDrafts";

function draft(input: Partial<ThreadDraftListItem> & { draftId: string; documentId: string }) {
  return {
    status: "active",
    documentName: null,
    lastActorTurnId: null,
    updatedAt: "2026-06-27T12:00:00.000Z",
    ...input,
  } satisfies ThreadDraftListItem;
}

describe("groupDraftsByDocument", () => {
  it("groups active drafts by document while preserving first-seen order", () => {
    const docOneFirst = draft({ draftId: "draft-1", documentId: "doc-1" });
    const docTwo = draft({ draftId: "draft-2", documentId: "doc-2" });
    const docOneSecond = draft({ draftId: "draft-3", documentId: "doc-1" });

    expect(groupDraftsByDocument([docOneFirst, docTwo, docOneSecond])).toEqual([
      { documentId: "doc-1", documentName: null, drafts: [docOneFirst, docOneSecond] },
      { documentId: "doc-2", documentName: null, drafts: [docTwo] },
    ]);
  });
});
