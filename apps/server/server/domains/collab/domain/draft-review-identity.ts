/**
 * The one module that maps a review item to its draft, document and draft (contract
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
import type { DraftReviewItem, DraftReviewItems } from "./draft-review-items.js";
import type { Drafts } from "./drafts.js";

export type ResolvedReviewItem = {
  draftId: DraftId;
  itemKey: DraftItemKey;
  documentId: DocumentId;
  item: DraftReviewItem;
  listed: boolean;
};

export interface DraftReviewIdentity {
  resolveReviewItem(input: { itemKey: string }): Promise<ResolvedReviewItem | null>;
  resolveReviewItemInDraft(input: {
    draftId: DraftId;
    documentId: DocumentId;
  }): Promise<ResolvedReviewItem | null>;
}

export function createDraftReviewIdentity(deps: {
  drafts: Pick<Drafts, "ownerOf">;
  reviewItems: Pick<DraftReviewItems, "resolve">;
}): DraftReviewIdentity {
  /** One document of a draft. */
  async function inDraft(draftId: DraftId, documentId: DocumentId) {
    const resolved = await deps.reviewItems.resolve(draftId, documentId);
    return resolved
      ? {
          draftId,
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
      return this.resolveReviewItemInDraft({
        draftId: parsed.draftId,
        documentId: parsed.documentId,
      });
    },
    async resolveReviewItemInDraft({ draftId, documentId }) {
      return (await deps.drafts.ownerOf(draftId)) ? inDraft(draftId, documentId) : null;
    },
  };
}
