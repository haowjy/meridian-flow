/** Resolves immutable draft origins to the active draft that continues them in the same branch. */

import type { InverseDocument } from "./turn-inverse-service.js";

export function currentInverseDraftId(document: InverseDocument, originDraftId: string): string {
  const origin = document.drafts.get(originDraftId)?.documentDraft;
  if (!origin) return originDraftId;
  const visited = new Set<string>();
  let current = origin;
  while (current.successorDraftId) {
    if (visited.has(current.draftId))
      throw new Error(`Draft continuation cycle at ${current.draftId}`);
    visited.add(current.draftId);
    const successor = document.drafts.get(current.successorDraftId)?.documentDraft;
    if (
      !successor ||
      successor.documentId !== origin.documentId ||
      successor.branchId !== origin.branchId
    )
      throw new Error(`Draft ${current.draftId} has an invalid continuation`);
    current = successor;
  }
  return current.status === "active" ? current.draftId : originDraftId;
}
