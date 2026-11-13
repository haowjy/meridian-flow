/** Editor-to-conversation reveal: one request, one owner per stage. */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { type PanePlace, useOptionalPanePlace } from "@/features/project/pane-place";

import {
  type ConversationRevealTarget,
  type ConversationRevealView,
  conversationRevealController,
  type TurnRevealRequest,
} from "./conversation-reveal-controller";

export type { ConversationRevealTarget, TurnRevealRequest };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Asks to reveal a conversation; it opens where the pane this is called in places it. */
export function useRequestConversationReveal(): (
  target: DistributiveOmit<ConversationRevealTarget, "from">,
) => void {
  const from = useOptionalPanePlace();
  return useCallback(
    (target) => conversationRevealController.request(from ? { ...target, from } : target),
    [from],
  );
}

function useRevealStage<T>(select: (view: ConversationRevealView) => T | null): T | null {
  return useSyncExternalStore(
    conversationRevealController.subscribe,
    () => select(conversationRevealController.snapshot()),
    () => null,
  );
}

/** Binds the thread stage to the shell that owns conversation surfaces. */
export function useConversationRevealRouting(
  revealConversation: (threadId: string, from: PanePlace | undefined) => void,
): void {
  const request = useRevealStage((current) => current.thread);
  const reveal = useRef(revealConversation);
  reveal.current = revealConversation;

  useEffect(() => {
    if (!request) return;
    reveal.current(request.threadId, request.from);
    request.landed();
  }, [request]);
}

/** The turn this thread's transcript must land on, or null when none is owed. */
export function useTurnReveal(threadId: string): TurnRevealRequest | null {
  return useRevealStage((current) => (current.turn?.threadId === threadId ? current.turn : null));
}
