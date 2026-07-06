import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { projectQueryKeys } from "./project-query-keys";
import { reviewRequestId } from "./useDraftReviewMutations";

describe("reviewRequestId", () => {
  it("uses branchId for branch review payloads", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      projectQueryKeys.workDraftPreview("project", "work", "doc", "branch-1"),
      {
        status: "active",
        branchId: "branch-1",
        live: "",
        preview: "",
        liveRevisionToken: 1,
        draftRevisionToken: 1,
        inlineModelPresent: true,
        operations: [],
        hunks: [],
      },
    );

    expect(
      reviewRequestId(queryClient, {
        projectId: "project",
        workId: "work",
        documentId: "doc",
        draftId: "branch-1",
      }),
    ).toEqual({ branchId: "branch-1" });
  });

  it("keeps branch previews on the draftId path for partial apply requests", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      projectQueryKeys.workDraftPreview("project", "work", "doc", "branch-1"),
      {
        status: "active",
        branchId: "branch-1",
        live: "",
        preview: "",
        liveRevisionToken: 1,
        draftRevisionToken: 1,
        inlineModelPresent: true,
        operations: [],
        hunks: [],
      },
    );

    expect(
      reviewRequestId(queryClient, {
        projectId: "project",
        workId: "work",
        documentId: "doc",
        draftId: "branch-1",
        operationIds: ["op-1"],
      }),
    ).toEqual({ draftId: "branch-1" });
  });

  it("uses draftId for legacy draft review payloads", () => {
    const queryClient = new QueryClient();

    expect(
      reviewRequestId(queryClient, {
        projectId: "project",
        workId: "work",
        documentId: "doc",
        draftId: "draft-1",
      }),
    ).toEqual({ draftId: "draft-1" });
  });
});
