/** Browser evidence capture without a second server projection or classification. */

import { type DraftOwner, draftOwnerKey } from "@meridian/contracts";
import type { DraftProvenanceResponse } from "@meridian/contracts/branches";
import type { DocumentId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import { ownerKeyOfColumns } from "../../../shared/draft-owner.js";
import { isPending, readDraftChanges } from "./draft-changes.js";
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
        cut.draft.documentDraft.documentId !== documentId
      )
        continue;
      assertReadableDraft(cut.draft.documentDraft);
      const doc = materializeDraftRead(cut.draft);
      try {
        const { reading, parts } = readDraftChanges(doc, cut.parts);
        const carried = new Set(cut.applied.map((key) => key.join(":")));
        const applied = (id: number) => {
          const changes = parts.get(id)?.changes ?? [];
          return changes.length > 0 && changes.every((_, index) => carried.has(`${id}:${index}`));
        };
        const members: Record<string, string[]> = {};
        for (const part of cut.parts) {
          if (!part.owner) continue;
          for (const change of parts.get(part.id)?.changes ?? [])
            if (isPending(change))
              for (const index of change.sitsIn) {
                const id = reading.pending.groups[index].id;
                const chats = members[id] ?? [];
                if (!chats.includes(part.owner.threadId)) chats.push(part.owner.threadId);
                members[id] = chats;
              }
        }
        out.set(draftId, {
          members,
          userId: cut.userId,
          snapshot: Array.from(Y.encodeSnapshot(Y.snapshot(doc))),
          parts: cut.parts.map(
            ({ id, threadId, turnId, toolCallId, inserted, deleted, owner, taken }) => ({
              threadId,
              turnId,
              ...(toolCallId ? { toolCallId } : {}),
              inserted,
              deleted,
              ...(taken ? { taken: true as const } : {}),
              ...(applied(id) ? { applied: true as const } : {}),
              owner,
            }),
          ),
        });
      } finally {
        doc.destroy();
      }
    }
    return out;
  };
}
