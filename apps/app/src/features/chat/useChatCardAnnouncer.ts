/**
 * useChatCardAnnouncer — the one announcer for chat failure cards. It speaks each card key once, when
 * the writer watched the card appear, and clears the live region when that card ends. Cards pass
 * `announce={false}` and hooks never call `announceError` for a chat failure.
 *
 * A card present when the history settles (a reload, a restored command, a failure first seen on
 * load) is the baseline and stays silent. Every key that appears after it is announced once. A card
 * that leaves (the chat moved past it, the turn was forgotten, the command was answered) takes its
 * alert down, leaving any other alert alone. A card whose sentence changes while it lives (a Stop's
 * failure that becomes the queue's once its reply ended) is spoken again, so the region never keeps
 * words the card no longer says.
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
  const state = useRef<{
    threadId: string;
    known: Map<string, string> | null;
    owned: Set<string>;
  }>({
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
    const words = new Map(cards.map((card) => [card.key, chatCardText(card)]));
    const keys = new Set(words.keys());
    if (settled && live.known !== null) {
      for (const [key, text] of words) {
        const before = live.known.get(key);
        // New to the writer, or its sentence changed since it was last spoken or seen.
        if (before === text || (before !== undefined && !live.owned.has(key))) continue;
        announceError(text, { key });
        live.owned.add(key);
      }
    }
    for (const key of live.owned) {
      if (keys.has(key)) continue;
      clearAnnouncement(key);
      live.owned.delete(key);
    }
    // Before the history settles nothing was watched; the first settled projection is the baseline.
    live.known = settled ? words : null;
  }, [cards, settled, threadId]);

  useEffect(() => {
    const live = state;
    return () => {
      for (const key of live.current.owned) clearAnnouncement(key);
    };
  }, []);
}
