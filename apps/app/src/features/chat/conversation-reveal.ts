/** One-shot editor-to-conversation reveal handshake. */
import { useSyncExternalStore } from "react";

export type ConversationReveal = {
  threadId: string;
  turnId: string | null;
  changeId: string;
};

type Listener = () => void;

let pending: ConversationReveal | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function requestConversationReveal(reveal: ConversationReveal): void {
  pending = reveal;
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

export function usePendingConversationReveal(): ConversationReveal | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pending,
    () => null,
  );
}

export function peekConversationReveal(): ConversationReveal | null {
  return pending;
}
