import { CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { describe, expect, it, vi } from "vitest";
import { isDrafted } from "../../file-policy/domain/policy.js";
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
  it("does not reject committed Apply when terminal maintenance fails", async () => {
    const { service, maintenanceFailed } = fixture();
    const selection = {
      ...command,
      operationIds: ["1"],
      liveRevisionToken: "live",
      draftRevisionToken: "draft",
    };
    const result = service.draftReview.applyWorkDraftChanges(selection as never);
    await expect(result).resolves.toMatchObject({
      status: "applied",
      draftClosed: false,
    });
    expect(maintenanceFailed).toHaveBeenCalled();
  });
});

it("lists the document's own location, not a manuscript-only path", async () => {
  const schemes = CONTEXT_URI_SCHEMES.filter(isDrafted);
  const uris = schemes.map((scheme) => `${scheme}://sheets/one`);
  const service = createWorkDraftReviewService({
    workDraftPending: {
      list: async () =>
        uris.map((_, index) => ({
          branch: {
            documentId: String(index),
            branchId: `draft-${index}`,
            generation: 1,
            updatedAt: new Date(0),
          },
          actorThreadIds: [],
        })),
    },
    resolveDocumentUris: async () => new Map(uris.map((uri, index) => [String(index), uri])),
    resolveThreadTitles: async () => new Map(),
  } as unknown as Parameters<typeof createWorkDraftReviewService>[0]);
  const rows = await service.draftReview.list({ workId: "work" } as never);
  expect(rows.map((row) => row.contextLocation)).toEqual(
    schemes.map((scheme) => ({ scheme, path: "/sheets/one" })),
  );
});
