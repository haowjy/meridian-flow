/**
 * One-shot editor-to-conversation reveal handshake.
 *
 * A reveal request names a conversation and, optionally, how deep into it to
 * land: a turn, and a change row inside that turn's receipt. Whoever can honor
 * the deepest named target completes the handshake, so a request never lingers
 * once the writer is looking at what they asked for.
 *
 * Opening a conversation is a REVEAL, never a screen swap: the shell routes a
 * pending request onto whatever surface already hosts the conversation on the
 * writer's current screen (`useConversationRevealRouting`).
 */
import { useEffect, useRef, useSyncExternalStore } from "react";

export type ConversationReveal = {
  threadId: string;
  /** Turn to land on; null when the trail carries no turn receipt. */
  turnId: string | null;
  /** Change row inside the turn's receipt; null when the turn itself is the target. */
  changeId: string | null;
};

type Listener = () => void;

let pending: ConversationReveal | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
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
    subscribe,
    () => (pending?.threadId === threadId ? pending : null),
    () => null,
  );
}

export function peekConversationReveal(): ConversationReveal | null {
  return pending;
}

/**
 * Binds pending reveal requests to the shell that owns conversation surfaces.
 *
 * `revealConversation` must bring the named conversation into view WITHOUT
 * leaving the current screen wherever a surface can host it; only shells with
 * no such surface (the phone, which shows one view at a time) may navigate.
 */
export function useConversationRevealRouting(revealConversation: (threadId: string) => void): void {
  const pendingReveal = useSyncExternalStore(
    subscribe,
    () => pending,
    () => null,
  );
  const reveal = useRef(revealConversation);
  reveal.current = revealConversation;

  useEffect(() => {
    if (!pendingReveal) return;
    reveal.current(pendingReveal.threadId);
    // No turn means nothing deeper can complete the handshake — the
    // conversation itself was the whole request.
    if (pendingReveal.turnId === null) completeConversationReveal(pendingReveal);
  }, [pendingReveal]);
}
