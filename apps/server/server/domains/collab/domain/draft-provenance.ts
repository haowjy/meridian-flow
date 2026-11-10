/** Browser evidence capture without a second server projection or classification. */

import { type DraftOwner, draftOwnerKey } from "@meridian/contracts";
import type { DraftProvenanceResponse } from "@meridian/contracts/branches";
import type { DocumentId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import { ownerKeyOfColumns } from "../../../shared/draft-owner.js";
import { assertReadableDraft, materializeDraftRead } from "./draft-store.js";
import type { DraftDispositionStore } from "./ports/draft-disposition-store.js";

export function createDraftProvenanceReader(store: DraftDispositionStore) {
  return async (input: {
    draftId: string;
    owner: DraftOwner;
    documentId: DocumentId;
    writerRanges: readonly (readonly [number, number, number])[];
  }): Promise<DraftProvenanceResponse | null> => {
    const cut = await store.capture(input.draftId, { writerRanges: input.writerRanges });
    if (
      !cut ||
      ownerKeyOfColumns(cut.draft.documentDraft) !== draftOwnerKey(input.owner) ||
      cut.draft.documentDraft.documentId !== input.documentId ||
      cut.draft.documentDraft.status !== "active"
    )
      return null;
    assertReadableDraft(cut.draft.documentDraft);
    const doc = materializeDraftRead(cut.draft);
    try {
      return {
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
      };
    } finally {
      doc.destroy();
    }
  };
}
