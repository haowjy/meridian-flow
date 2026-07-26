/**
 * Editor-to-conversation reveal: one request, one owner per stage.
 *
 * A request names how deep to land — a thread, a turn inside it, or a change
 * row inside that turn's receipt — and the surfaces that host those things take
 * it one stage at a time:
 *
 *   thread (shell) → turn (transcript) → change (turn receipt)
 *
 * Exactly one stage is ever in flight, and the surface holding it must report
 * one of two outcomes once its own data settles: `landed` (the writer is
 * looking at it) or `unavailable` (it is not there). An unavailable stage ends
 * the request where its parent left the writer — a change row that never
 * renders still leaves them on its turn, a turn that never arrives still leaves
 * them in the thread. That handoff, not a timer, is what keeps a request from
 * outliving everything that could complete it.
 *
 * Opening a conversation is a REVEAL, never a screen swap: the shell routes a
 * pending request onto whatever surface already hosts the conversation on the
 * writer's current screen (`useConversationRevealRouting`).
 */
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

/**
 * Binds the thread stage to the shell that owns conversation surfaces.
 *
 * `revealConversation` must bring the named conversation into view WITHOUT
 * leaving the current screen wherever a surface can host it; only shells with
 * no such surface (the phone, which shows one view at a time) may navigate.
 * The shell always lands: pointing a surface at a thread cannot fail, so this
 * stage has no `unavailable`.
 */
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
