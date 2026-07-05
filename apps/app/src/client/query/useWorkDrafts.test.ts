import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";

import { groupDraftsByDocument, hasActivePartialAccept } from "./useWorkDrafts";

const base = {
  documentId: "doc-1",
  documentName: "chapter-1.md",
  contextPath: "/chapter-1.md",
  lastActorTurnId: "turn-1",
  appliedAt: null,
  discardedAt: null,
  wordsAdded: null,
  wordsRemoved: null,
} satisfies Omit<ThreadDraftListItem, "draftId" | "status" | "updatedAt">;

function draft(input: {
  draftId: string;
  status: ThreadDraftListItem["status"];
  updatedAt: string;
}): ThreadDraftListItem {
  return { ...base, ...input };
}

describe("groupDraftsByDocument", () => {
  it("deduplicates repeated draft rows and keeps active drafts before terminal rows", () => {
    const groups = groupDraftsByDocument([
      draft({ draftId: "draft-applied", status: "applied", updatedAt: "2026-07-03T01:00:00Z" }),
      draft({ draftId: "draft-active", status: "active", updatedAt: "2026-07-03T00:00:00Z" }),
      draft({ draftId: "draft-applied", status: "applied", updatedAt: "2026-07-03T01:00:00Z" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.drafts.map((item) => item.draftId)).toEqual([
      "draft-active",
      "draft-applied",
    ]);
  });
});

describe("hasActivePartialAccept", () => {
  it("detects active drafts with unreversed partial accepts", () => {
    expect(
      hasActivePartialAccept({
        ...draft({ draftId: "draft-active", status: "active", updatedAt: "2026-07-03T00:00:00Z" }),
        partialAcceptedOperationCount: 1,
        proposedOperationCount: 3,
      }),
    ).toBe(true);
  });

  it("turns off after the partial accept is undone", () => {
    expect(
      hasActivePartialAccept({
        ...draft({ draftId: "draft-active", status: "active", updatedAt: "2026-07-03T00:00:00Z" }),
        partialAcceptedOperationCount: 0,
        proposedOperationCount: 3,
      }),
    ).toBe(false);
  });

  it("does not affect applied draft undo affordances", () => {
    expect(
      hasActivePartialAccept({
        ...draft({
          draftId: "draft-applied",
          status: "applied",
          updatedAt: "2026-07-03T00:00:00Z",
        }),
        partialAcceptedOperationCount: 3,
        proposedOperationCount: 3,
      }),
    ).toBe(false);
  });
});
