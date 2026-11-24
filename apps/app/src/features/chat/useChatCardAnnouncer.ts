import type { ChatCard } from "@meridian/thread-client";
import { useEffect, useRef } from "react";
import { announceErrors, clearAnnouncement } from "@/client/stores";
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
    pending: Set<string>;
  }>({
    threadId,
    known: null,
    owned: new Set(),
    pending: new Set(),
  });

  useEffect(() => {
    const current = state.current;
    if (current.threadId !== threadId) {
      for (const key of [...current.owned, ...current.pending]) clearAnnouncement(key);
      state.current = { threadId, known: null, owned: new Set(), pending: new Set() };
    }
    const live = state.current;
    const words = new Map(cards.map((card) => [card.key, chatCardText(card)]));
    const keys = new Set(words.keys());
    if (settled && live.known !== null) {
      const pending = [...words].filter(([key, text]) => {
        const before = live.known?.get(key);
        return before !== text && (before === undefined || live.owned.has(key));
      });
      if (pending.length) {
        for (const [key] of pending) live.pending.add(key);
        announceErrors(
          pending.map(([key, message]) => ({ key, message })),
          (published) => {
            for (const key of published) {
              const text = words.get(key);
              if (text === undefined) continue;
              live.known?.set(key, text);
              live.pending.delete(key);
              live.owned.add(key);
            }
          },
        );
      }
    }
    for (const key of [...live.owned, ...live.pending]) {
      if (keys.has(key)) continue;
      clearAnnouncement(key);
      live.owned.delete(key);
      live.pending.delete(key);
    }
    if (!settled) live.known = null;
    else if (live.known === null) live.known = words;
    else for (const key of live.known.keys()) if (!keys.has(key)) live.known.delete(key);
  }, [cards, settled, threadId]);

  useEffect(() => {
    const live = state;
    return () => {
      for (const key of [...live.current.owned, ...live.current.pending]) clearAnnouncement(key);
    };
  }, []);
}
