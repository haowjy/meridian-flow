/**
 * useChatCardAnnouncer — the one announcer for chat failure cards. It speaks each card key once, when
 * the writer watched the card appear, and clears the live region when that card ends. Cards pass
 * `announce={false}` and hooks never call `announceError` for a chat failure.
 *
 * A card present when the history settles (a reload, a restored command, a failure first seen on
 * load) is the baseline and stays silent. Every key that appears after it is announced once. A card
 * that leaves (the chat moved past it, the turn was forgotten, the command was answered) takes its
 * alert down, leaving any other alert alone.
 */
import type { ChatCard } from "@meridian/thread-client";
import { useEffect, useRef } from "react";
import { announceError, clearAnnouncement } from "@/client/stores";
import { chatCardText } from "./chat-card-copy";

export function useChatCardAnnouncer(
  threadId: string,
  cards: readonly ChatCard[],
  settled: boolean,
): void {
  const state = useRef<{ threadId: string; known: Set<string> | null; owned: Set<string> }>({
    threadId,
    known: null,
    owned: new Set(),
  });

  useEffect(() => {
    const current = state.current;
    if (current.threadId !== threadId) {
      for (const key of current.owned) clearAnnouncement(key);
      state.current = { threadId, known: null, owned: new Set() };
    }
    const live = state.current;
    const keys = new Set(cards.map((card) => card.key));
    if (settled && live.known !== null) {
      for (const card of cards) {
        if (live.known.has(card.key)) continue;
        announceError(chatCardText(card), { key: card.key });
        live.owned.add(card.key);
      }
    }
    for (const key of live.owned) {
      if (keys.has(key)) continue;
      clearAnnouncement(key);
      live.owned.delete(key);
    }
    // Before the history settles nothing was watched; the first settled projection is the baseline.
    live.known = settled ? keys : null;
  }, [cards, settled, threadId]);

  useEffect(() => {
    const live = state;
    return () => {
      for (const key of live.current.owned) clearAnnouncement(key);
    };
  }, []);
}
