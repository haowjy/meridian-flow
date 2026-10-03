/**
 * Refused draft commands, held by draft identity (documentId + draftId).
 *
 * A refused Discard leaves the draft pending, so every surface that lists the
 * draft (composer strip, Work Files) shows the error on that draft's row,
 * whichever review scope ran the command and whichever surface is mounted. The
 * error clears on the next action on the draft (Discard retry, Apply, opening
 * Review) or when the draft is discarded or applied.
 */
import { create } from "zustand";
import type { InlineReviewMessageCode } from "./draft-review-session";

type DraftRef = { documentId: string; draftId: string };

type DraftCommandErrors = Readonly<Record<string, InlineReviewMessageCode>>;

const useDraftCommandErrorStore = create<{ errors: DraftCommandErrors }>(() => ({ errors: {} }));

export function draftCommandErrorKey({ documentId, draftId }: DraftRef): string {
  return `${documentId}\u0000${draftId}`;
}

export function setDraftCommandError(draft: DraftRef, code: InlineReviewMessageCode): void {
  useDraftCommandErrorStore.setState((state) => ({
    errors: { ...state.errors, [draftCommandErrorKey(draft)]: code },
  }));
}

export function clearDraftCommandError(draft: DraftRef): void {
  const key = draftCommandErrorKey(draft);
  useDraftCommandErrorStore.setState((state) => {
    if (!(key in state.errors)) return state;
    const { [key]: _cleared, ...errors } = state.errors;
    return { errors };
  });
}

/** Every held error; look rows up with `draftCommandErrorKey`. */
export function useDraftCommandErrors(): DraftCommandErrors {
  return useDraftCommandErrorStore((state) => state.errors);
}

export function resetDraftCommandErrors(): void {
  useDraftCommandErrorStore.setState({ errors: {} });
}
