/**
 * Whether a draft's parts were applied, and by which Apply, at a captured draft revision. An Apply
 * in force names the changes it took (`carried`, written with its effect), so this reads no Yjs
 * item id. Whether a change of a part still waits is `draft-changes.ts`'s read of its text.
 */
import { assertReadableDraft } from "./draft-store.js";
import type { DraftDispositionStore, DraftReceiptPart } from "./ports/draft-disposition-store.js";

export type PartDisposition = "applied" | "pending" | "discarded";
/**
 * The writer's apply or discard of a part, if they made one. It outranks whatever the text says
 * about the part (a sibling change applied, or the writer typed over it).
 */
export const settledCause = (disposition: PartDisposition) =>
  disposition === "applied" || disposition === "discarded" ? disposition : null;
export interface DraftDispositionView {
  draft: import("./draft-store.js").DraftSnapshot;
  /**
   * `applied`: an Apply in force took a change of the part. Else `pending` while the draft is
   * open, and `discarded` once it is closed.
   */
  parts: readonly (DraftReceiptPart & { disposition: PartDisposition })[];
}

export function createDraftDispositionReader(store: DraftDispositionStore) {
  return async (draftId: string): Promise<DraftDispositionView | null> => {
    const cut = await store.capture(draftId);
    if (!cut) return null;
    const draft = cut.draft.documentDraft;
    // Never manufacture an empty draft.
    if (!cut.draft.checkpoint) throw new Error(`Missing draft checkpoint: ${draftId}`);
    assertReadableDraft(draft);
    const applied = new Set(cut.applied.flatMap((apply) => apply.carried.map(([part]) => part)));
    return {
      draft,
      parts: cut.parts.map((part) => ({
        ...part,
        disposition: applied.has(part.id) ? "applied" : "pending",
      })),
    };
  };
}
