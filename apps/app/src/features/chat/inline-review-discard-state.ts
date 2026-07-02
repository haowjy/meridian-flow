/** inline-review-discard-state — shared pending flag for inline proposal discards. */
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const pendingTokens = new Set<string>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): boolean {
  return pendingTokens.size > 0;
}

export function useInlineReviewDiscardPending(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

export function inlineReviewDiscardIsPending(): boolean {
  return snapshot();
}

export function markInlineReviewDiscardPending(token: string): void {
  const sizeBefore = pendingTokens.size;
  pendingTokens.add(token);
  if (pendingTokens.size !== sizeBefore) emit();
}

export function clearInlineReviewDiscardPending(token: string): void {
  const changed = pendingTokens.delete(token);
  if (changed) emit();
}
