/**
 * The one module that maps a review item to its draft, document and branch (contract
 * §1.2). The cut, the commands and the address route all resolve through it; none takes a
 * bare string that may be a `branches.id`, a draft id or an item key.
 *
 * Addressability is not listing: it answers for every document an active branch has
 * a view of (an active draft, or a change row), and says whether the list shows it. The
 * item is the metadata-only tree observation for every such document, listed or not.
 * Receipt membership enriches listed items downstream, never address resolution.
 */
import type { BranchId, DraftOwner } from "@meridian/contracts";
import { type DraftItemKey, parseDraftItemKey } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import { isUuid } from "../../../shared/uuid.js";
import type { BranchReviewItems, DraftReviewItem } from "./branch-review-items.js";
import type { Branches } from "./branches.js";

export type ResolvedReviewItem = {
  branchId: BranchId;
  itemKey: DraftItemKey;
  documentId: DocumentId;
  /** The branch's text draft on the document; server-internal, null when it has none. */
  draftId: string | null;
  item: DraftReviewItem;
  listed: boolean;
};

export interface BranchReviewIdentity {
  resolveReviewItem(input: { itemKey: string }): Promise<ResolvedReviewItem | null>;
  resolveReviewItemInBranch(input: {
    branchId: BranchId;
    documentId: DocumentId;
  }): Promise<ResolvedReviewItem | null>;
  resolveReviewItemByDocument(input: {
    owner: DraftOwner;
    documentId: DocumentId;
  }): Promise<ResolvedReviewItem | null>;
}

export function createBranchReviewIdentity(deps: {
  branches: Pick<Branches, "activeForOwner" | "ownerOf">;
  reviewItems: Pick<BranchReviewItems, "resolve">;
}): BranchReviewIdentity {
  /** One document of an already selected branch: a key never moves to a replacement branch. */
  async function inBranch(branchId: BranchId, documentId: DocumentId) {
    const resolved = await deps.reviewItems.resolve(branchId, documentId);
    return resolved
      ? {
          branchId,
          itemKey: resolved.item.itemKey,
          documentId,
          draftId: resolved.item.draftId,
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
      const found = await deps.branches.ownerOf(branchId);
      return found?.branch.status === "active" ? inBranch(branchId, documentId) : null;
    },
    async resolveReviewItemByDocument({ owner, documentId }) {
      const branch = await deps.branches.activeForOwner(owner);
      return branch ? inBranch(branch.id, documentId) : null;
    },
  };
}
