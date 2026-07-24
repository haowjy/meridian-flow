/** One-shot editor-to-conversation reveal handshake. */
import { useSyncExternalStore } from "react";

export type ConversationReveal = {
  threadId: string;
  turnId: string | null;
  changeId: string;
};

type Listener = () => void;
type Navigator = (threadId: string) => void;

let pending: ConversationReveal | null = null;
let navigator: Navigator | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function requestConversationReveal(reveal: ConversationReveal): void {
  pending = reveal;
  navigator?.(reveal.threadId);
  if (navigator && reveal.turnId === null) pending = null;
  emit();
}

export function completeConversationReveal(reveal: ConversationReveal): void {
  if (
    pending?.threadId !== reveal.threadId ||
    pending.turnId !== reveal.turnId ||
    pending.changeId !== reveal.changeId
  ) {
    return;
  }
  pending = null;
  emit();
}

export function registerConversationRevealNavigator(next: Navigator): () => void {
  navigator = next;
  if (pending) {
    next(pending.threadId);
    if (pending.turnId === null) {
      pending = null;
      emit();
    }
  }
  return () => {
    if (navigator === next) navigator = null;
  };
}

export function useConversationReveal(threadId: string): ConversationReveal | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (pending?.threadId === threadId ? pending : null),
    () => null,
  );
}

export function peekConversationReveal(): ConversationReveal | null {
  return pending;
}
