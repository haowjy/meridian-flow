/** Draft listing bulk-resolves paths and preserves durable modification times. */
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import { expect, it } from "vitest";
import { createWorkDraftReviewService } from "./work-draft-review-service.js";

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
  const drafts = await createWorkDraftReviewService(input).draftSessionStats.listActiveDraftsByWork(
    { workId },
  );
  expect(drafts.map((draft) => draft.updatedAt)).toEqual([updatedAt, updatedAt]);
  expect(drafts.map((draft) => draft.contextPath)).toEqual(["/folder/a.md", "/folder/b.md"]);
});
