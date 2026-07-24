/** Behavioral contract for the shared Apply disposition layer. */
import type { DraftAcceptResponse } from "@meridian/contracts/drafts";
import { describe, expect, it, vi } from "vitest";
import { acquireDraftApplyRequest, draftApplyOutcome } from "./draft-review-session";

describe("draft Apply disposition", () => {
  it.each([
    "draft",
    "operation",
  ] as const)("routes terminal %s Apply responses through the shared draft transition", (scope) => {
    const response: DraftAcceptResponse = { status: "applied", draftId: "draft-1" };

    expect(draftApplyOutcome(scope, response)).toEqual({
      command: { kind: "applied" },
      message: null,
      refreshDraftId: null,
      materializedDocument: true,
    });
  });

  it("maps a partial per-card Apply to its reversible receipt", () => {
    const response: DraftAcceptResponse = {
      status: "partial_applied",
      draftId: "draft-1",
      writeId: "write-1",
    };

    expect(draftApplyOutcome("operation", response)).toEqual({
      command: { kind: "partial-applied", writeId: "write-1" },
      message: { code: "change-applied", writeId: "write-1" },
      refreshDraftId: null,
      materializedDocument: true,
    });
  });

  it("refreshes stale responses while preserving each Apply surface's transition", () => {
    const response: DraftAcceptResponse = {
      status: "stale_draft",
      draftId: "draft-2",
      draftRevisionToken: 2,
    };

    expect(draftApplyOutcome("operation", response)).toEqual({
      command: { kind: "stale", draftId: "draft-2" },
      message: { code: "changes-moved-refreshed" },
      refreshDraftId: "draft-2",
      materializedDocument: false,
    });
    expect(draftApplyOutcome("draft", response)).toEqual({
      command: { kind: "stale", draftId: "draft-2" },
      message: null,
      refreshDraftId: "draft-2",
      materializedDocument: false,
    });
  });
});

describe("draft Apply revision acquisition", () => {
  const displayedPreview = {
    documentId: "document-1",
    draftId: "draft-1",
    branchId: "branch-1",
    draftRevisionToken: 4,
    operationIds: ["operation-1", "operation-2"],
  };

  it("keeps whole-draft Apply pinned to the displayed preview", () => {
    expect(acquireDraftApplyRequest({ scope: "draft", preview: displayedPreview })).toEqual({
      draftId: "draft-1",
      branchId: "branch-1",
      draftRevisionToken: 4,
      operationIds: ["operation-1", "operation-2"],
    });
  });

  it("refreshes per-card revision evidence but submits only the selected operation", async () => {
    const loadLatestPreview = vi.fn().mockResolvedValue({
      draftRevisionToken: 5,
      liveRevisionToken: 3,
      operationIds: ["operation-1", "operation-2", "operation-3"],
      branchId: "branch-1",
    });

    await expect(
      acquireDraftApplyRequest({
        scope: "operation",
        draftId: "draft-1",
        operationId: "operation-2",
        loadLatestPreview,
      }),
    ).resolves.toEqual({
      draftId: "draft-1",
      branchId: "branch-1",
      draftRevisionToken: 5,
      operationIds: ["operation-2"],
    });
    expect(loadLatestPreview).toHaveBeenCalledOnce();
  });
});
