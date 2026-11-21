/**
 * The one module that maps a review item to its draft, document and branch (contract
 * §1.2). The cut, the commands and the address route all resolve through it; none takes a
 * bare string that may be a draft id or an item key.
 *
 * Addressability is not listing: it answers for every document a draft has a view of (a pending
 * create, or a change row), and says whether the list shows it. The
 * item is the metadata-only tree observation for every such document, listed or not.
 * Receipt membership enriches listed items downstream, never address resolution.
 */
import type { DraftId } from "@meridian/contracts";
import { type DraftItemKey, parseDraftItemKey } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import { isUuid } from "../../../shared/uuid.js";
import type { BranchReviewItems, DraftReviewItem } from "./branch-review-items.js";
import type { Branches } from "./branches.js";

export type ResolvedReviewItem = {
  branchId: DraftId;
  itemKey: DraftItemKey;
  documentId: DocumentId;
  item: DraftReviewItem;
  listed: boolean;
};

export interface BranchReviewIdentity {
  resolveReviewItem(input: { itemKey: string }): Promise<ResolvedReviewItem | null>;
  resolveReviewItemInBranch(input: {
    branchId: DraftId;
    documentId: DocumentId;
  }): Promise<ResolvedReviewItem | null>;
}

export function createBranchReviewIdentity(deps: {
  branches: Pick<Branches, "ownerOf">;
  reviewItems: Pick<BranchReviewItems, "resolve">;
}): BranchReviewIdentity {
  /** One document of a draft. */
  async function inBranch(branchId: DraftId, documentId: DocumentId) {
    const resolved = await deps.reviewItems.resolve(branchId, documentId);
    return resolved
      ? {
          branchId,
          itemKey: resolved.item.itemKey,
          documentId,
          item: resolved.item,
          listed: resolved.listed,
        }
      : null;
  }

  return {
    async resolveReviewItem({ itemKey }) {
      const parsed = parseDraftItemKey(itemKey);
      if (!parsed || !isUuid(parsed.documentId)) return null;
      return this.resolveReviewItemInBranch({
        branchId: parsed.branchId,
        documentId: parsed.documentId,
      });
    },
    async resolveReviewItemInBranch({ branchId, documentId }) {
      return (await deps.branches.ownerOf(branchId)) ? inBranch(branchId, documentId) : null;
    },
  };
}
