/**
 * One asker for every link a React surface shows: what the Editor's
 * decoration plugin does in its `view()`, for a surface with no document to
 * scan (the chat transcript).
 *
 * A shown link `watch`es its href while mounted. The requester asks the cache
 * about the whole watched set in one `request()`, coalesced to one microtask,
 * whenever a link starts being watched and whenever the cache publishes (an
 * answer, or a new generation whose answers are gone). An href with an answer
 * or a failure is never asked again, so the loop ends. Per-link asking was
 * O(links × publishes): every publish woke every link to ask for itself.
 *
 * It subscribes only while something is watched, so an instance a StrictMode
 * double render throws away holds nothing.
 */

import type { LinkResolution } from "./link-resolution";

export type LinkRequester = {
  /** Ask about this href while it is shown; the return stops watching it. */
  watch(href: string): () => void;
};

export function createLinkRequester(resolution: LinkResolution): LinkRequester {
  /** Watched hrefs, counted: two chips can show one link. */
  const watched = new Map<string, number>();
  let unsubscribe: (() => void) | null = null;
  let scheduled = false;

  // Deferred: asking publishes, and a publish answered by asking again from
  // inside the listener loop would re-enter it.
  const ask = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (watched.size > 0) resolution.request([...watched.keys()]);
    });
  };

  return {
    watch(href) {
      if (watched.size === 0) unsubscribe = resolution.subscribe(ask);
      watched.set(href, (watched.get(href) ?? 0) + 1);
      ask();
      let watching = true;
      return () => {
        if (!watching) return;
        watching = false;
        const left = (watched.get(href) ?? 1) - 1;
        if (left > 0) watched.set(href, left);
        else watched.delete(href);
        if (watched.size === 0) {
          unsubscribe?.();
          unsubscribe = null;
        }
      };
    },
  };
}
