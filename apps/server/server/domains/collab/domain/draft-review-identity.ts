/**
 * The one module that maps a review item to its draft, document and branch (contract
 * §1.2). The cut, the commands and the address route all resolve through it; none takes a
 * bare string that may be a `drafts.id`, a branch id or an item key.
 *
 * Addressability is not listing: it answers for every document the Work's active draft has
 * a view of (an active branch, or a change row), and says whether the list shows it. The
 * item is the tree-derived observation read for every such document, listed or not.
 */
import type { DraftId } from "@meridian/contracts";
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import { isUuid } from "../../../shared/uuid.js";
import { type DraftItemKey, draftItemKey } from "./draft-tree-payload.js";
import type { DraftReviewItem, DraftReviewItems } from "./draft-review-items.js";
import type { Drafts } from "./drafts.js";

export type ResolvedReviewItem = {
  draftId: DraftId;
  itemKey: DraftItemKey;
  documentId: DocumentId;
  /** The draft's text branch on the document; server-internal, null when it has none. */
  draftBranchId: string | null;
  item: DraftReviewItem;
  listed: boolean;
};

export interface DraftReviewIdentity {
  resolveReviewItem(input: {
    workId: WorkId;
    itemKey: string;
  }): Promise<ResolvedReviewItem | null>;
  resolveReviewItemByDocument(input: {
    workId: WorkId;
    documentId: DocumentId;
  }): Promise<ResolvedReviewItem | null>;
}

export function createDraftReviewIdentity(deps: {
  drafts: Pick<Drafts, "activeForWork">;
  reviewItems: Pick<DraftReviewItems, "resolve">;
}): DraftReviewIdentity {
  async function byDocument(workId: WorkId, documentId: DocumentId) {
    const draft = await deps.drafts.activeForWork(workId);
    if (!draft) return null;
    const resolved = await deps.reviewItems.resolve(draft.id, documentId);
    return resolved
      ? {
          draftId: draft.id,
          itemKey: resolved.item.itemKey,
          documentId,
          draftBranchId: resolved.item.draftBranchId,
          item: resolved.item,
          listed: resolved.listed,
        }
      : null;
  }

  return {
    async resolveReviewItem({ workId, itemKey }) {
      const draft = await deps.drafts.activeForWork(workId);
      if (!draft) return null;
      const prefix = `${draft.id}:`;
      if (!itemKey.startsWith(prefix)) return null;
      const documentId = itemKey.slice(prefix.length) as DocumentId;
      if (!isUuid(documentId) || draftItemKey(draft.id, documentId) !== itemKey) return null;
      return byDocument(workId, documentId);
    },
    resolveReviewItemByDocument: ({ workId, documentId }) => byDocument(workId, documentId),
  };
}
