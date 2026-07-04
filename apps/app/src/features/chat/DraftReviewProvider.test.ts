import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { reviewableDraftsFromGroup } from "./DraftReviewProvider";

const NOW = Date.parse("2026-07-04T12:00:00.000Z");

function draft(input: {
  draftId: string;
  status: ThreadDraftListItem["status"];
  updatedAt: string;
}): ThreadDraftListItem {
  return {
    draftId: input.draftId,
    documentId: "doc-1",
    documentName: "Chapter 1",
    status: input.status,
    updatedAt: input.updatedAt,
    appliedAt: input.status === "applied" ? input.updatedAt : null,
    discardedAt: input.status === "discarded" ? input.updatedAt : null,
  } as ThreadDraftListItem;
}

function group(drafts: ThreadDraftListItem[]): ThreadDraftGroup {
  return { documentId: "doc-1", documentName: "Chapter 1", contextPath: null, drafts };
}

describe("reviewableDraftsFromGroup", () => {
  it("hides terminal undoable rows when a newer active draft exists", () => {
    const result = reviewableDraftsFromGroup(
      group([
        draft({ draftId: "active-new", status: "active", updatedAt: "2026-07-04T12:00:00.000Z" }),
        draft({ draftId: "applied-old", status: "applied", updatedAt: "2026-07-04T11:59:00.000Z" }),
      ]),
      NOW,
    );

    expect(result.visible.map((item) => item.draftId)).toEqual(["active-new"]);
    expect(result.active.map((item) => item.draftId)).toEqual(["active-new"]);
  });

  it("keeps a terminal undoable row when it is alone", () => {
    const result = reviewableDraftsFromGroup(
      group([
        draft({ draftId: "applied", status: "applied", updatedAt: "2026-07-04T11:59:00.000Z" }),
      ]),
      NOW,
    );

    expect(result.visible.map((item) => item.draftId)).toEqual(["applied"]);
    expect(result.active).toEqual([]);
  });

  it("keeps both rows when the terminal row is newer than the active draft", () => {
    const result = reviewableDraftsFromGroup(
      group([
        draft({ draftId: "active-old", status: "active", updatedAt: "2026-07-04T11:59:00.000Z" }),
        draft({ draftId: "applied-new", status: "applied", updatedAt: "2026-07-04T12:00:00.000Z" }),
      ]),
      NOW,
    );

    expect(result.visible.map((item) => item.draftId)).toEqual(["active-old", "applied-new"]);
    expect(result.active.map((item) => item.draftId)).toEqual(["active-old"]);
  });
});
