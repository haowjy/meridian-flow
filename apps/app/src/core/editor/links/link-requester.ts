/**
 * One asker for every link a React surface shows: what the Editor's
 * decoration plugin does in its `view()`, for a surface with no document to
 * scan (the chat transcript).
 *
 * A shown link `watch`es its key while mounted. The requester asks the cache
 * about the whole watched set in one `request()`, coalesced to one microtask,
 * whenever a link starts being watched and whenever the cache publishes (an
 * answer, or a new generation whose answers are gone). A link with an answer
 * or a failure is never asked again, so the loop ends. Per-link asking was
 * O(links × publishes): every publish woke every link to ask for itself.
 *
 * It subscribes only while something is watched, so an instance a StrictMode
 * double render throws away holds nothing.
 */

import type { LinkAnswerCache, LinkKey } from "./link-resolution";

export type LinkRequester = {
  /** Ask about this link while it is shown; the return stops watching it. */
  watch(link: LinkKey): () => void;
};

export function createLinkRequester(resolution: LinkAnswerCache): LinkRequester {
  /** Watched links by ref and href, counted: two chips can show one link. */
  const watched = new Map<string, { link: LinkKey; count: number }>();
  let unsubscribe: (() => void) | null = null;
  let scheduled = false;

  // Deferred: asking publishes, and a publish answered by asking again from
  // inside the listener loop would re-enter it.
  const ask = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (watched.size > 0) resolution.request([...watched.values()].map(({ link }) => link));
    });
  };

  return {
    watch(link) {
      const key = `${link.ref ?? ""}\u0000${link.href}`;
      if (watched.size === 0) unsubscribe = resolution.subscribe(ask);
      const entry = watched.get(key);
      if (entry) entry.count += 1;
      else watched.set(key, { link, count: 1 });
      ask();
      let watching = true;
      return () => {
        if (!watching) return;
        watching = false;
        const current = watched.get(key);
        if (current && current.count > 1) current.count -= 1;
        else watched.delete(key);
        if (watched.size === 0) {
          unsubscribe?.();
          unsubscribe = null;
        }
      };
    },
  };
}
