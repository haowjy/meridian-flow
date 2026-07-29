/**
 * What an internal link points at, right now.
 *
 * Resolution is per-request and never persisted (law 9): an LLM emits
 * `[[The Second Gate]]` with no extra attributes, and whether that names a
 * document is a question about the project this minute, not a fact about the
 * mark. So the document holds the spelling and this holds the answer, keyed by
 * the classifier's own spelling of the href — two ways of writing one target
 * share an entry, and a second normalizer never appears.
 *
 * Unresolved is a normal, rendered state, not an error: serial writers link
 * chapters and characters before they exist. A FAILED request is a different
 * thing entirely and caches nothing, because a link the editor could not ask
 * about must never be drawn as a link that does not exist.
 *
 * The port is the app's: only it knows the project, the work, and the URI of
 * the document holding the link. Until one registers, every read is null and
 * the manuscript renders exactly as it did before this module existed.
 */

import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";

import {
  classifyLinkTarget,
  isInternalLinkTarget,
  type LinkTarget,
  linkTargetHref,
} from "./link-target";

export type LinkResolutionState = "pending" | "resolved" | "unresolved";

export type LinkResolutionEntry =
  | { state: "pending"; document: null }
  | { state: "resolved"; document: ResolvedDocumentLink }
  | { state: "unresolved"; document: null };

/**
 * Asks the project about one internal target. Null is the answer for "nothing
 * matched" AND for "several did" — ambiguity resolves to nothing rather than
 * to a guess. Throwing is the other outcome: the question could not be asked.
 */
export type InternalLinkResolver = (target: LinkTarget) => Promise<ResolvedDocumentLink | null>;

export type LinkResolution = {
  subscribe: (listener: () => void) => () => void;
  /** False while no port is registered, which is a real state and not a bug. */
  readonly available: boolean;
  /**
   * The answer for this href as it stands, or null when there is nothing to
   * say: an external link, an unclassifiable one, a failed request, or no port
   * yet. Pure — a renderer may call it as often as it likes.
   */
  read: (href: string) => LinkResolutionEntry | null;
  /** Ask about every internal href here that has no answer yet. */
  request: (hrefs: Iterable<string>) => void;
  /**
   * The answer, waited for — what a click needs, because the writer is already
   * asking to go there. Null carries the same "nothing to say" meaning, and a
   * previous failure is retried rather than remembered.
   */
  resolve: (href: string) => Promise<LinkResolutionEntry | null>;
  registerResolver: (resolve: InternalLinkResolver) => () => void;
  /** Forget every answer: the project's documents changed underneath them. */
  refresh: () => void;
  destroy: () => void;
};

const PENDING: LinkResolutionEntry = Object.freeze({ state: "pending", document: null });
const UNRESOLVED: LinkResolutionEntry = Object.freeze({ state: "unresolved", document: null });

/**
 * How many questions are in flight at once. A chapter can carry dozens of
 * links and every answer is a query over the project's documents, so they go
 * in a few at a time; the cache makes it one question per distinct target for
 * as long as the document stays open.
 */
const MAX_IN_FLIGHT = 4;

type Waiter = {
  promise: Promise<LinkResolutionEntry | null>;
  settle: (entry: LinkResolutionEntry | null) => void;
};

export function createLinkResolution(): LinkResolution {
  const listeners = new Set<() => void>();
  const answers = new Map<string, LinkResolutionEntry>();
  const waiting = new Map<string, Waiter>();
  const queue: { key: string; target: LinkTarget }[] = [];
  /** Keys whose request failed. Not answers — questions that never got asked. */
  const failed = new Set<string>();
  let resolver: InternalLinkResolver | null = null;
  let running = 0;
  /** Bumped by every refresh, so an answer in flight from before is dropped. */
  let generation = 0;

  const publish = () => {
    for (const listener of listeners) listener();
  };

  /** The canonical spelling of an internal href, or null for anything else. */
  const internalHref = (href: string): { key: string; target: LinkTarget } | null => {
    const target = classifyLinkTarget(href);
    if (!target || !isInternalLinkTarget(target)) return null;
    return { key: linkTargetHref(target), target };
  };

  const settle = (key: string, entry: LinkResolutionEntry | null, at: number) => {
    const waiter = waiting.get(key);
    waiting.delete(key);
    const current = at === generation;
    if (current) {
      if (entry) answers.set(key, entry);
      else {
        answers.delete(key);
        failed.add(key);
      }
    }
    // An answer about a project state nobody is looking at any more tells the
    // caller nothing, so it comes back null rather than stale.
    waiter?.settle(current ? entry : null);
    if (current) publish();
  };

  const pump = () => {
    while (running < MAX_IN_FLIGHT && queue.length > 0) {
      const next = queue.shift();
      if (!next) return;
      const at = generation;
      const port = resolver;
      if (!port) {
        settle(next.key, null, at);
        continue;
      }

      running += 1;
      void port(next.target)
        .then((document) =>
          settle(next.key, document ? { state: "resolved", document } : UNRESOLVED, at),
        )
        .catch(() => settle(next.key, null, at))
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  };

  const enqueue = (key: string, target: LinkTarget): Promise<LinkResolutionEntry | null> => {
    const already = waiting.get(key);
    if (already) return already.promise;

    let settleWaiter: Waiter["settle"] = () => {};
    const promise = new Promise<LinkResolutionEntry | null>((done) => {
      settleWaiter = done;
    });
    waiting.set(key, { promise, settle: settleWaiter });
    answers.set(key, PENDING);
    queue.push({ key, target });
    pump();
    return promise;
  };

  const forget = () => {
    generation += 1;
    for (const waiter of waiting.values()) waiter.settle(null);
    waiting.clear();
    answers.clear();
    failed.clear();
    queue.length = 0;
    running = 0;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    get available() {
      return resolver !== null;
    },

    read(href) {
      if (!resolver) return null;
      const internal = internalHref(href);
      return internal ? (answers.get(internal.key) ?? null) : null;
    },

    request(hrefs) {
      if (!resolver) return;
      let asked = false;
      for (const href of hrefs) {
        const internal = internalHref(href);
        if (!internal || answers.has(internal.key) || failed.has(internal.key)) continue;
        enqueue(internal.key, internal.target);
        asked = true;
      }
      // Pending is a state a renderer may show, so say it once rather than per
      // href — and never when nothing actually changed.
      if (asked) publish();
    },

    async resolve(href) {
      if (!resolver) return null;
      const internal = internalHref(href);
      if (!internal) return null;
      const known = answers.get(internal.key);
      if (known && known.state !== "pending") return known;
      // A click is the writer asking again, so a failure is worth retrying.
      failed.delete(internal.key);
      return enqueue(internal.key, internal.target);
    },

    registerResolver(resolve) {
      resolver = resolve;
      forget();
      publish();
      return () => {
        if (resolver !== resolve) return;
        resolver = null;
        forget();
        publish();
      };
    },

    refresh() {
      forget();
      publish();
    },

    destroy() {
      forget();
      listeners.clear();
      resolver = null;
    },
  };
}
