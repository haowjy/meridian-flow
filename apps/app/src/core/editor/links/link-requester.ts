import { afterCurrentDispatch } from "@/lib/after-current-dispatch";
import { type LinkAnswerCache, type LinkKey, linkCacheKey } from "./link-resolution";

export type LinkRequester = {
  watch(link: LinkKey): () => void;
};

export function createLinkRequester(resolution: LinkAnswerCache): LinkRequester {
  const watched = new Map<string, { link: LinkKey; count: number }>();
  let unsubscribe: (() => void) | null = null;
  const request = () => {
    if (watched.size > 0) resolution.request([...watched.values()].map(({ link }) => link));
  };
  const ask = () => afterCurrentDispatch(request);

  return {
    watch(link) {
      const key = linkCacheKey(link);
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
