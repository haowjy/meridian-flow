/** A review key names one draft; a replacement draft opened mid-request never answers for it. */
import type { BranchId } from "@meridian/contracts";
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import { expect, it, vi } from "vitest";
import { createBranchReviewIdentity } from "./branch-review-identity.js";
import { draftItemKey } from "./branch-tree-payload.js";

const WORK = "00000000-0000-4000-8000-000000000001" as WorkId;
const D1 = "00000000-0000-4000-8000-0000000000d1" as BranchId;
const D2 = "00000000-0000-4000-8000-0000000000d2" as BranchId;
const DOC = "00000000-0000-4000-8000-0000000000aa" as DocumentId;

it("resolves a key inside the draft it validated, even if another draft became active", async () => {
  const activeForWork = vi.fn().mockResolvedValueOnce({ id: D1 }).mockResolvedValue({ id: D2 });
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
    itemKey: draftItemKey(D1, DOC),
  });
  expect(resolved?.branchId).toBe(D1);
  expect(resolve).toHaveBeenCalledWith(D1, DOC);
});
