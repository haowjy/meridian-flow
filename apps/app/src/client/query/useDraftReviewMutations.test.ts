import { describe, expect, it } from "vitest";

import { reviewRequestId } from "./useDraftReviewMutations";

describe("reviewRequestId", () => {
  it("uses explicit branchId for branch review payloads without preview cache inference", () => {
    expect(
      reviewRequestId({
        projectId: "project",
        workId: "work",
        documentId: "doc",
        draftId: "branch-1",
        branchId: "branch-1",
      }),
    ).toEqual({ branchId: "branch-1" });
  });

  it("keeps explicit branch reviews on the draftId path for partial apply requests", () => {
    expect(
      reviewRequestId({
        projectId: "project",
        workId: "work",
        documentId: "doc",
        draftId: "branch-1",
        branchId: "branch-1",
        operationIds: ["op-1"],
      }),
    ).toEqual({ draftId: "branch-1" });
  });

  it("uses draftId for legacy draft review payloads", () => {
    expect(
      reviewRequestId({
        projectId: "project",
        workId: "work",
        documentId: "doc",
        draftId: "draft-1",
      }),
    ).toEqual({ draftId: "draft-1" });
  });
});
