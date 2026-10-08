/** Draft review service boundaries: command completion versus maintenance, and bulk draft listing. */
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { cloneDoc, createDoc, model } from "./draft-review-test-fixture.js";
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
  it("never interprets an empty selection as whole Discard", async () => {
    const { service, discard } = fixture();
    await expect(
      service.draftReview.discardWorkDraft({ ...command, operationIds: [] } as never),
    ).resolves.toMatchObject({ status: "gone" });
    expect(discard).not.toHaveBeenCalled();
  });
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

it("returns review metadata without serializing whole documents", async () => {
  const live = createDoc("Alpha base.");
  const serializeDocument = vi.fn(async () => "whole document");
  const service = createWorkDraftReviewService({
    readLiveReviewCut: async () => ({ doc: cloneDoc(live), revision: "live" }),
    branches: {
      resolveWorkDraftBranchForWork: async () => ({
        branchId: "draft",
        generation: 1,
        doc: cloneDoc(live),
      }),
    },
    branchJournal: { listReviewableJournalRows: async () => [] },
    resolveThreadTitles: async () => new Map(),
    model,
    documents: { serializeDocument },
  } as unknown as Parameters<typeof createWorkDraftReviewService>[0]);
  const result = await service.draftReview.preview(command as never);
  expect(result.status).toBe("active");
  expect(result).not.toHaveProperty("live");
  expect(result).not.toHaveProperty("markdown");
  expect(serializeDocument).not.toHaveBeenCalled();
  live.destroy();
});

it("lists draft paths through one bulk port with persisted timestamps", async () => {
  const updatedAt = new Date("2026-01-02T03:04:05Z");
  const workId = "work" as WorkId;
  const ids = ["a", "b"] as DocumentId[];
  const input = {
    workDraftPending: {
      list: async () =>
        ids.map((documentId) => ({
          branch: { branchId: documentId, documentId, workId, generation: 1, updatedAt },
          rows: [],
        })),
    },
    resolveDocumentUri: async () => {
      throw new Error("serial lookup");
    },
    resolveDocumentUris: async (documentIds: readonly string[]) => {
      expect(documentIds).toEqual(ids);
      return new Map(ids.map((id) => [id, `manuscript://folder/${id}.md`]));
    },
  } as unknown as Parameters<typeof createWorkDraftReviewService>[0];
  const drafts = await createWorkDraftReviewService(input).draftReview.list({ workId });
  expect(drafts.map((draft) => draft.updatedAt)).toEqual([updatedAt, updatedAt]);
  expect(drafts.map((draft) => draft.contextPath)).toEqual(["/folder/a.md", "/folder/b.md"]);
});
