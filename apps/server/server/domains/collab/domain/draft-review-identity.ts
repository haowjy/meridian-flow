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
