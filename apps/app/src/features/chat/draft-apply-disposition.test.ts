/** Behavioral contract for the shared Apply disposition layer. */
import type { DraftAcceptResponse } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";
import { acquireDraftApplyRequest, draftApplyOutcome } from "./draft-review-session";

describe("draft Apply disposition", () => {
  it("routes the terminal Apply response through the shared draft transition", () => {
    const response: DraftAcceptResponse = { status: "applied", draftId: "draft-1" };

    expect(draftApplyOutcome(response)).toEqual({
      command: { kind: "applied" },
      message: null,
      refreshDraftId: null,
      materializedDocument: true,
    });
  });
});

describe("draft Apply request", () => {
  const displayedPreview = {
    documentId: "document-1",
    draftId: "draft-1",
    branchId: "branch-1",
    draftRevisionToken: 4,
    operationIds: ["operation-1", "operation-2"],
  };

  it("identifies the branch without pinning Apply to preview operations", () => {
    expect(acquireDraftApplyRequest({ scope: "draft", preview: displayedPreview })).toEqual({
      draftId: "draft-1",
      branchId: "branch-1",
    });
  });
});
