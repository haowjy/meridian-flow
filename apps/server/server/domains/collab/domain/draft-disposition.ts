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
   * `applied`: an Apply in force took a change of the part. `appliedChanges` names, by index in
   * the part's delta, the Apply command that took each; the latest when two did. Else `pending`
   * while the draft is open, and `discarded` once it is closed.
   */
  parts: readonly (DraftReceiptPart & {
    disposition: PartDisposition;
    appliedChanges: ReadonlyMap<number, string>;
  })[];
}

export function createDraftDispositionReader(store: DraftDispositionStore) {
  return async (draftId: string): Promise<DraftDispositionView | null> => {
    const cut = await store.capture(draftId);
    if (!cut) return null;
    const draft = cut.draft.documentDraft;
    // Never manufacture an empty draft.
    if (!cut.draft.checkpoint) throw new Error(`Missing draft checkpoint: ${draftId}`);
    assertReadableDraft(draft);
    // Effects arrive oldest first, so the later Apply wins a change two took.
    const takenBy = new Map<number, Map<number, string>>();
    for (const effect of cut.applied)
      for (const [part, index] of effect.carried) {
        const changes = takenBy.get(part) ?? new Map<number, string>();
        changes.set(index, effect.commandId);
        takenBy.set(part, changes);
      }
    return {
      draft,
      parts: cut.parts.map((part) => {
        const appliedChanges = takenBy.get(part.id) ?? new Map<number, string>();
        return {
          ...part,
          appliedChanges,
          disposition: appliedChanges.size ? "applied" : "pending",
        };
      }),
    };
  };
}
