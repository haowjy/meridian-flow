import { describe, expect, it } from "vitest";

import { operationAcceptRequest } from "./useDraftReviewController";

describe("operationAcceptRequest", () => {
  it("resends per-operation accept with fresh overlap and closure confirmation", () => {
    expect(
      operationAcceptRequest({
        draftId: "draft-1",
        draftRevisionToken: 12,
        operationId: "op-3",
        acceptClosureOperationIds: ["op-1", "op-2", "op-3"],
        liveRevisionToken: 7,
        confirmClosure: true,
        overlap: { draftId: "draft-1", operationId: "op-3", liveRevisionToken: 9 },
      }),
    ).toEqual({
      draftId: "draft-1",
      draftRevisionToken: 12,
      operationIds: ["op-3"],
      confirmedClosureOperationIds: ["op-1", "op-2", "op-3"],
      confirmOverlap: true,
      confirmedLiveRevisionToken: 7,
    });
  });

  it("uses the model token for closure-only confirmation", () => {
    expect(
      operationAcceptRequest({
        draftId: "draft-1",
        draftRevisionToken: 12,
        operationId: "op-2",
        acceptClosureOperationIds: ["op-1", "op-2"],
        liveRevisionToken: 7,
        confirmClosure: true,
        overlap: null,
      }),
    ).toMatchObject({
      confirmedClosureOperationIds: ["op-1", "op-2"],
      confirmedLiveRevisionToken: 7,
    });
  });
});
