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
 * The port is the app's: only it knows the project, the work, the URI of the
 * document holding the link, and which documents the project holds. Until one
 * registers, every read is null and the manuscript renders exactly as it did
 * before this module existed.
 *
 * **A registration is a generation, and a generation owns everything true of
 * it** — its answers, the questions it has out, and the counter admitting them.
 * The app re-registers whenever any of those inputs change, so a scope change
 * landing mid-flight is ordinary rather than exotic; a promise already out
 * cannot be recalled, so the generation it was asked in is what it settles
 * against. That is the whole invalidation mechanism: there is no second verb
 * that drops answers, and no caller has to know one.
 */

import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";

import {
  classifyLinkTarget,
  isInternalLinkTarget,
  type LinkTarget,
  linkTargetHref,
} from "./link-target";

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
  /**
   * Registers the port and starts a generation with it. Every answer and every
   * failure the previous one produced is gone at that moment, which is what
   * makes this the app's only invalidation: register again and the last
   * generation's answers are unreachable.
   */
  registerResolver: (resolve: InternalLinkResolver) => () => void;
  destroy: () => void;
};

const PENDING: LinkResolutionEntry = Object.freeze({ state: "pending", document: null });
const UNRESOLVED: LinkResolutionEntry = Object.freeze({ state: "unresolved", document: null });

/**
 * How many questions are in flight at once. A chapter can carry dozens of
 * links and every answer is a query over the project's documents, so they go
 * in a few at a time; the cache makes it one question per distinct target for
 * as long as the generation lasts.
 */
const MAX_IN_FLIGHT = 4;

/**
 * One question, and everything needed to settle it: which generation asked it,
 * and the single waiter that gets the answer. Owning the waiter is the point —
 * looking one up by href at completion time is how an answer from a project
 * nobody is looking at any more ends up settling somebody else's promise.
 */
type Request = {
  readonly key: string;
  readonly target: LinkTarget;
  readonly generation: Generation;
  readonly promise: Promise<LinkResolutionEntry | null>;
  readonly settle: (entry: LinkResolutionEntry | null) => void;
};

/** Everything true of one registration of the port. */
type Generation = {
  readonly resolver: InternalLinkResolver;
  /** Answers, keyed by the classifier's spelling of the href. */
  readonly answers: Map<string, LinkResolutionEntry>;
  /** Keys whose request failed. Not answers — questions that never got asked. */
  readonly failed: Set<string>;
  /** The one question out for a key, queued or in flight. */
  readonly asking: Map<string, Request>;
  readonly queue: Request[];
  /** How many of THIS generation's questions the port is holding. */
  running: number;
};

export function createLinkResolution(): LinkResolution {
  const listeners = new Set<() => void>();
  /** The only generation anyone can read. Null until a port registers. */
  let current: Generation | null = null;

  const publish = () => {
    for (const listener of listeners) listener();
  };

  /** The canonical spelling of an internal href, or null for anything else. */
  const internalHref = (href: string): { key: string; target: LinkTarget } | null => {
    const target = classifyLinkTarget(href);
    if (!target || !isInternalLinkTarget(target)) return null;
    return { key: linkTargetHref(target), target };
  };

  const settle = (request: Request, entry: LinkResolutionEntry | null) => {
    const { generation, key } = request;
    // This request's own entry and no other: after a re-registration the map
    // under this href can hold the next generation's question about it.
    if (generation.asking.get(key) === request) generation.asking.delete(key);
    if (entry) generation.answers.set(key, entry);
    else {
      generation.answers.delete(key);
      generation.failed.add(key);
    }
    // An answer about a project state nobody is looking at any more tells the
    // caller nothing, so it comes back null rather than stale.
    const live = generation === current;
    request.settle(live ? entry : null);
    if (live) publish();
  };

  const pump = (generation: Generation) => {
    while (generation.running < MAX_IN_FLIGHT && generation.queue.length > 0) {
      const request = generation.queue.shift();
      if (!request) return;

      generation.running += 1;
      void generation
        .resolver(request.target)
        .then((document) =>
          settle(request, document ? { state: "resolved", document } : UNRESOLVED),
        )
        .catch(() => settle(request, null))
        .finally(() => {
          // The counter belongs to the generation that admitted the request. A
          // question coming back from an abandoned one must not admit work into
          // the live one, which is what a shared counter did.
          generation.running -= 1;
          pump(generation);
        });
    }
  };

  const ask = (
    generation: Generation,
    key: string,
    target: LinkTarget,
  ): Promise<LinkResolutionEntry | null> => {
    const already = generation.asking.get(key);
    if (already) return already.promise;

    let settleWaiter: Request["settle"] = () => {};
    const promise = new Promise<LinkResolutionEntry | null>((done) => {
      settleWaiter = done;
    });
    const request: Request = { key, target, generation, promise, settle: settleWaiter };
    generation.asking.set(key, request);
    generation.answers.set(key, PENDING);
    generation.queue.push(request);
    pump(generation);
    return promise;
  };

  /**
   * Nothing this generation was asked can be answered any more. Queued
   * questions are dropped, and the ones already out are abandoned: whoever was
   * waiting hears null now rather than a fact about a project state that moved.
   * Its answers go with the generation itself, which nothing can reach again.
   */
  const retire = (generation: Generation) => {
    generation.queue.length = 0;
    for (const request of generation.asking.values()) request.settle(null);
    generation.asking.clear();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    get available() {
      return current !== null;
    },

    read(href) {
      if (!current) return null;
      const internal = internalHref(href);
      return internal ? (current.answers.get(internal.key) ?? null) : null;
    },

    request(hrefs) {
      const generation = current;
      if (!generation) return;
      let asked = false;
      for (const href of hrefs) {
        const internal = internalHref(href);
        if (!internal) continue;
        if (generation.answers.has(internal.key) || generation.failed.has(internal.key)) continue;
        ask(generation, internal.key, internal.target);
        asked = true;
      }
      // Pending is a state a renderer may show, so say it once rather than per
      // href — and never when nothing actually changed.
      if (asked) publish();
    },

    async resolve(href) {
      const generation = current;
      if (!generation) return null;
      const internal = internalHref(href);
      if (!internal) return null;
      const known = generation.answers.get(internal.key);
      if (known && known.state !== "pending") return known;
      // A click is the writer asking again, so a failure is worth retrying.
      generation.failed.delete(internal.key);
      return ask(generation, internal.key, internal.target);
    },

    registerResolver(resolve) {
      const previous = current;
      current = {
        resolver: resolve,
        answers: new Map(),
        failed: new Set(),
        asking: new Map(),
        queue: [],
        running: 0,
      };
      if (previous) retire(previous);
      publish();

      const generation = current;
      return () => {
        // Identity, not the function: the same port registered against a new
        // catalog is a new generation, and the old unregister must not take it.
        if (current !== generation) return;
        current = null;
        retire(generation);
        publish();
      };
    },

    destroy() {
      if (current) retire(current);
      current = null;
      listeners.clear();
    },
  };
}
