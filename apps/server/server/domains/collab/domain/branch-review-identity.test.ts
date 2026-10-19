/** A review key names one branch and document; a replacement branch opened mid-request never answers for it. */
import type { BranchId } from "@meridian/contracts";
import { draftItemKey } from "@meridian/contracts";
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import { expect, it, vi } from "vitest";
import { createBranchReviewIdentity } from "./branch-review-identity.js";

const WORK = "00000000-0000-4000-8000-000000000001" as WorkId;
const B1 = "00000000-0000-4000-8000-0000000000b1" as BranchId;
const B2 = "00000000-0000-4000-8000-0000000000b2" as BranchId;
const DOC = "00000000-0000-4000-8000-0000000000aa" as DocumentId;

it("resolves a key inside the branch it validated, even if another branch became active", async () => {
  const activeForWork = vi.fn().mockResolvedValueOnce({ id: B1 }).mockResolvedValue({ id: B2 });
  const resolve = vi.fn(async (branchId: BranchId, documentId: DocumentId) => ({
    item: { itemKey: draftItemKey(branchId, documentId), draftId: null },
    listed: true,
  }));
  const identity = createBranchReviewIdentity({
    branches: { activeForWork } as never,
    reviewItems: { resolve } as never,
  });
  const resolved = await identity.resolveReviewItem({
    workId: WORK,
    itemKey: draftItemKey(B1, DOC),
  });
  expect(resolved?.branchId).toBe(B1);
  expect(resolve).toHaveBeenCalledWith(B1, DOC);
});
