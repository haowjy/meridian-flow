/** Editor-to-conversation reveal: one request, one owner per stage. */
import { useEffect, useRef, useSyncExternalStore } from "react";

import {
  type ChangeRevealRequest,
  type ConversationRevealTarget,
  type ConversationRevealView,
  conversationRevealController,
  type TurnRevealRequest,
} from "./conversation-reveal-controller";

export type { ChangeRevealRequest, ConversationRevealTarget, TurnRevealRequest };

export function requestConversationReveal(target: ConversationRevealTarget): void {
  conversationRevealController.request(target);
}

function useRevealStage<T>(select: (view: ConversationRevealView) => T | null): T | null {
  return useSyncExternalStore(
    conversationRevealController.subscribe,
    () => select(conversationRevealController.snapshot()),
    () => null,
  );
}

/** Binds the thread stage to the shell that owns conversation surfaces. */
export function useConversationRevealRouting(revealConversation: (threadId: string) => void): void {
  const request = useRevealStage((current) => current.thread);
  const reveal = useRef(revealConversation);
  reveal.current = revealConversation;

  useEffect(() => {
    if (!request) return;
    reveal.current(request.threadId);
    request.landed();
  }, [request]);
}

/** The turn this thread's transcript must land on, or null when none is owed. */
export function useTurnReveal(threadId: string): TurnRevealRequest | null {
  return useRevealStage((current) => (current.turn?.threadId === threadId ? current.turn : null));
}

/** The change row this turn's receipt must bring into view, or null. */
export function useChangeReveal(threadId: string, turnId: string): ChangeRevealRequest | null {
  return useRevealStage((current) =>
    current.change?.threadId === threadId && current.change.turnId === turnId
      ? current.change
      : null,
  );
}
