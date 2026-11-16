/** Browser evidence capture without a second server projection or classification. */

import { type DraftOwner, draftOwnerKey } from "@meridian/contracts";
import type { DraftProvenanceResponse } from "@meridian/contracts/branches";
import type { DocumentId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import { ownerKeyOfColumns } from "../../../shared/draft-owner.js";
import { assertReadableDraft, materializeDraftRead } from "./draft-store.js";
import type { DraftDispositionStore } from "./ports/draft-disposition-store.js";

/**
 * Each named draft's evidence, by draft id, from one capture. A draft that is not the owner's
 * active draft of the named document is absent.
 */
export function createDraftProvenanceReader(store: DraftDispositionStore) {
  return async (input: {
    owner: DraftOwner;
    drafts: readonly { draftId: string; documentId: DocumentId }[];
  }): Promise<Map<string, DraftProvenanceResponse>> => {
    const cuts = await store.captureAll(input.drafts.map((draft) => draft.draftId));
    const out = new Map<string, DraftProvenanceResponse>();
    for (const { draftId, documentId } of input.drafts) {
      const cut = cuts.get(draftId);
      if (
        !cut ||
        ownerKeyOfColumns(cut.draft.documentDraft) !== draftOwnerKey(input.owner) ||
        cut.draft.documentDraft.documentId !== documentId ||
        cut.draft.documentDraft.status !== "active"
      )
        continue;
      assertReadableDraft(cut.draft.documentDraft);
      const doc = materializeDraftRead(cut.draft);
      try {
        out.set(draftId, {
          userId: cut.userId,
          snapshot: Array.from(Y.encodeSnapshot(Y.snapshot(doc))),
          parts: cut.parts.map(({ threadId, turnId, toolCallId, inserted, deleted, owner }) => ({
            threadId,
            turnId,
            ...(toolCallId ? { toolCallId } : {}),
            inserted,
            deleted,
            owner,
          })),
          ...(cut.writers ? { writers: cut.writers } : {}),
        });
      } finally {
        doc.destroy();
      }
    }
    return out;
  };
}
