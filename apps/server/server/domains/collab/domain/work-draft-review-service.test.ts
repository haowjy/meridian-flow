import { describe, expect, it, vi } from "vitest";
import { createWorkDraftReviewService } from "./work-draft-review-service.js";

const command = { draftId: "draft", workId: "work", documentId: "doc", userId: "writer" };
function fixture() {
  const discard = vi.fn(async () => {});
  const maintenanceFailed = vi.fn();
  const service = createWorkDraftReviewService({
    branches: {
      getBranch: async () => ({
        kind: "work_draft",
        status: "active",
        workId: "work",
        documentId: "doc",
        branchId: "draft",
      }),
    },
    discardWorkDraft: discard,
    agentEdit: { invalidateThread: async () => {} },
    branchPush: { pushSelectedToLive: async () => ({ status: "pushed" }) },
    branchReview: { discardSelected: async () => ({ status: "discarded" }) },
    settleEmptyDraft: async () => {
      throw new Error("maintenance unavailable");
    },
    diagnostics: { dispositionMaintenanceFailed: maintenanceFailed },
  } as unknown as Parameters<typeof createWorkDraftReviewService>[0]);
  return { service, discard, maintenanceFailed };
}
describe("draft command boundary", () => {
  it.each([
    "apply",
    "discard",
  ])("does not reject committed %s when terminal maintenance fails", async (mode) => {
    const { service, maintenanceFailed } = fixture();
    const selection = {
      ...command,
      operationIds: ["1"],
      liveRevisionToken: "live",
      draftRevisionToken: "draft",
    };
    const result =
      mode === "apply"
        ? service.draftReview.applyWorkDraftChanges(selection as never)
        : service.draftReview.discardWorkDraft(selection as never);
    await expect(result).resolves.toMatchObject({
      status: mode === "apply" ? "applied" : "discarded",
      draftClosed: false,
    });
    expect(maintenanceFailed).toHaveBeenCalled();
  });
});
