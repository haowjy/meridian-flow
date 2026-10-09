/**
 * What an internal link points at, right now.
 *
 * Resolution is per-request and never persisted (law 9): the mark stores what
 * the link names (a `ref` beside the href it was written with) and whether that
 * document is reachable, and where it lives now, is a question about the
 * project this minute. So the document holds the link and this holds the
 * answer, keyed by the link's whole identity: its ref and the classifier's
 * spelling of its href (`LinkKey`). Two links sharing an href but naming
 * different documents never share an answer, and a second normalizer never
 * appears.
 *
 * Gone is an answer too: a ref whose document was deleted, discarded, or is
 * no longer readable. It is not "nothing at this address yet", and it never
 * falls back to the address.
 *
 * Missing is a normal, rendered state, not an error: serial writers link
 * chapters and characters before they exist. A FAILED request is a different thing
 * entirely and caches nothing, because a link the editor could not ask about
 * must never be drawn as a link that does not exist.
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
 *
 * **Local answers never wait on the network.** The port's `local` half runs
 * when a question is asked, so what the scope's own index can say is cached
 * before any request goes out, and a failed request fails only the questions
 * it carried. A local answer may also be provisional: shown at once while the
 * server is still asked, and replaced only by a server answer that names a
 * different document or says the ref is gone.
 *
 * A click outlives a generation. A question someone is waiting on through
 * `resolve()` is asked again in the generation that replaced its own, because
 * the writer asked to go somewhere and a catalog moving underneath them is not
 * an answer. Questions only the decorations asked are dropped with their
 * generation; the next scan asks them again.
 */

import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";

import type { LinkBindingIndex, LinkBindingScope } from "./link-binding";
import {
  classifyLinkTarget,
  isInternalLinkTarget,
  type LinkTarget,
  linkTargetHref,
} from "./link-target";

/** A stored link as resolution sees it: what it names and how it is spelled. */
export type LinkKey = { ref: string | null; href: string };

/**
 * The stored link a link mark's attributes name. The only reading of a mark's
 * `ref` and `href`, so no two surfaces can disagree about which answer a link
 * has (an empty ref is no ref).
 */
export function linkKeyOfMark(attrs: { readonly [attribute: string]: unknown }): LinkKey {
  const { ref, href } = attrs;
  return { ref: typeof ref === "string" && ref ? ref : null, href: String(href ?? "") };
}

/** The one string a `LinkKey` is cached and deduplicated under. */
export function linkCacheKey(key: LinkKey): string {
  return `${key.ref ?? ""}\u0000${key.href}`;
}

export type LinkResolutionEntry =
  | { state: "pending"; document: null }
  | { state: "document"; document: ResolvedDocumentLink }
  | { state: "missing"; document: null }
  /** A ref whose document the reader can no longer reach. Never followable. */
  | { state: "gone"; document: null };

/** A settled answer: every entry but pending. */
export type LinkAnswer = Exclude<LinkResolutionEntry, { state: "pending" }>;

/** One question for the port: the link's ref and its classified internal target. */
export type LinkQuestion = { ref: string | null; target: LinkTarget };

/**
 * What the scope knows about one question without the network.
 *
 * - `answered`: the scope's own answer, final for the generation; the server
 *   is not asked.
 * - `unasked`: the question cannot be asked here (a relative path with no
 *   base, say). Cached like a failure: no answer, never drawn as missing.
 * - `ask`: the server answers. A `provisional` answer is shown at once and
 *   stands unless the server answers `gone` or a different document.
 */
export type LocalLinkAnswer =
  | { kind: "answered"; answer: LinkAnswer }
  | { kind: "unasked" }
  | { kind: "ask"; provisional: DocumentAnswer | null };

export type DocumentAnswer = Extract<LinkAnswer, { state: "document" }>;

/**
 * The port. `local` runs synchronously when a question is asked, so local
 * answers are cached before any network call and no server failure can touch
 * them. `remote` gets only the questions `local` sent on, at most `MAX_BATCH`
 * at a time, and answers in question order; null for one question is a
 * failure of that question. Throwing fails that batch and nothing else.
 * Without `local`, every question goes to `remote`.
 */
export type InternalLinkResolver = {
  /**
   * The local document index the port answers from, which is also what a
   * link written into the holder binds against. Absent for a port with none.
   */
  index?: LinkBindingIndex | null;
  local?: (question: LinkQuestion) => LocalLinkAnswer;
  remote: (questions: readonly LinkQuestion[]) => Promise<readonly (LinkAnswer | null)[]>;
};

export type LinkAnswerCache = {
  subscribe: (listener: () => void) => () => void;
  /** False while no port is registered, which is a real state and not a bug. */
  readonly available: boolean;
  /**
   * The URI of the document holding the links, as the live registration
   * stated it: what a relative link's family is drawn from before it
   * resolves. Null with no registration, or before the holder is known.
   */
  readonly baseUri: string | null;
  /**
   * What a link written into the holder binds against (`link-binding.ts`):
   * its address, its project, and the local document index the live
   * registration was made with. Null with no registration.
   */
  readonly binding: LinkBindingScope | null;
  /**
   * The answer for this link as it stands, or null when there is nothing to
   * say: an external link, an unclassifiable one, a failed request, or no port
   * yet. Pure — a renderer may call it as often as it likes.
   */
  read: (link: LinkKey) => LinkResolutionEntry | null;
  /** Ask about every internal link here that has no answer yet. */
  request: (links: Iterable<LinkKey>) => void;
  /**
   * The answer, waited for — what a click needs, because the writer is already
   * asking to go there. Null carries the same "nothing to say" meaning, and a
   * previous failure is retried rather than remembered. A provisional answer
   * waits for the server, which may still say gone or name another document. A registration landing
   * while this waits asks the question again in the new generation rather than
   * answering null; only unregistering (or destroying) the port does that.
   */
  resolve: (link: LinkKey) => Promise<LinkResolutionEntry | null>;
  /**
   * Registers the port and starts a generation with it. Every answer and every
   * failure the previous one produced is gone at that moment, which is what
   * makes this the app's only invalidation: register again and the last
   * generation's answers are unreachable. `baseUri` is part of what the
   * generation is true of, so a base arriving is a new registration; so is
   * the binding context (project, and the port's own index).
   */
  registerResolver: (
    resolve: InternalLinkResolver,
    options?: { baseUri?: string | null; projectId?: string | null },
  ) => () => void;
  destroy: () => void;
};

const PENDING: LinkResolutionEntry = Object.freeze({ state: "pending", document: null });
const ASK: LocalLinkAnswer = Object.freeze({ kind: "ask", provisional: null });

/**
 * The server's answer, measured against the provisional one shown meanwhile:
 * the server wins only when it says something different about identity (gone,
 * or another document). Anything else, a failure included, keeps the local
 * answer the writer is already looking at.
 */
function settledOver(
  provisional: DocumentAnswer | null,
  entry: LinkResolutionEntry | null,
): LinkResolutionEntry | null {
  if (!provisional) return entry;
  if (entry?.state === "gone") return entry;
  if (entry?.state === "document" && entry.document.documentId !== provisional.document.documentId)
    return entry;
  return provisional;
}

/**
 * How many batches are in flight at once, and how many links one batch asks
 * about. A chapter can carry hundreds of links; they go to the port in
 * batches the resolve endpoint accepts, and the cache makes it one question
 * per distinct link for as long as the generation lasts.
 */
const MAX_IN_FLIGHT = 4;
const MAX_BATCH = 200;

/**
 * One question, and everything needed to settle it: which generation asked it,
 * and the single waiter that gets the answer. Owning the waiter is the point —
 * looking one up by key at completion time is how an answer from a project
 * nobody is looking at any more ends up settling somebody else's promise.
 */
type Request = {
  readonly key: string;
  readonly question: LinkQuestion;
  readonly generation: Generation;
  readonly promise: Promise<LinkResolutionEntry | null>;
  readonly settle: (entry: LinkResolutionEntry | null) => void;
  /** The local answer shown while the server is asked; see `settledOver`. */
  readonly provisional: DocumentAnswer | null;
  /** Someone is waiting through `resolve()`, so retirement carries it forward. */
  awaited: boolean;
};

/** Everything true of one registration of the port. */
type Generation = {
  readonly resolver: InternalLinkResolver;
  readonly baseUri: string | null;
  readonly binding: LinkBindingScope;
  /** Answers, keyed by the link's ref and the classifier's spelling of its href. */
  readonly answers: Map<string, LinkResolutionEntry>;
  /**
   * Keys whose last question failed. Usually no answer stands beside one; a
   * kept provisional answer may, and a click asks again about it.
   */
  readonly failed: Set<string>;
  /** The one question out for a key, queued or in flight. */
  readonly asking: Map<string, Request>;
  readonly queue: Request[];
  /** How many of THIS generation's questions the port is holding. */
  running: number;
};

export function createLinkAnswerCache(): LinkAnswerCache {
  const listeners = new Set<() => void>();
  /** The only generation anyone can read. Null until a port registers. */
  let current: Generation | null = null;

  const publish = () => {
    for (const listener of listeners) listener();
  };

  /** The cache key of an internal link, or null for anything else. */
  const internalLink = (link: LinkKey): { key: string; question: LinkQuestion } | null => {
    const target = classifyLinkTarget(link.href);
    if (!target || !isInternalLinkTarget(target)) return null;
    return {
      key: linkCacheKey({ ref: link.ref, href: linkTargetHref(target) }),
      question: { ref: link.ref, target },
    };
  };

  const settle = (request: Request, answer: LinkResolutionEntry | null) => {
    const { generation, key } = request;
    const entry = settledOver(request.provisional, answer);
    // This request's own entry and no other: after a re-registration the map
    // under this key can hold the next generation's question about it.
    if (generation.asking.get(key) === request) generation.asking.delete(key);
    const previous = generation.answers.get(key) ?? null;
    // A failure is remembered even under a kept provisional answer, so a click
    // asks the server again rather than trusting an answer it never confirmed.
    if (answer) generation.failed.delete(key);
    else generation.failed.add(key);
    if (entry) generation.answers.set(key, entry);
    else generation.answers.delete(key);
    // A generation stops being live only through `retire`, which has already
    // answered this waiter (null, or carried into the next generation). An
    // answer arriving afterwards is about a project state nobody is looking at.
    if (generation !== current) return;
    request.settle(entry);
    if (entry !== previous) publish();
  };

  const pump = (generation: Generation) => {
    while (generation.running < MAX_IN_FLIGHT && generation.queue.length > 0) {
      const batch = generation.queue.splice(0, MAX_BATCH);
      if (!batch.length) return;

      generation.running += 1;
      void generation.resolver
        .remote(batch.map((request) => request.question))
        .then((answers) => {
          if (answers.length !== batch.length) throw new Error("resolver answered out of shape");
          batch.forEach((request, at) => {
            settle(request, answers[at] ?? null);
          });
        })
        .catch(() => {
          for (const request of batch) settle(request, null);
        })
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
    question: LinkQuestion,
  ): Promise<LinkResolutionEntry | null> => {
    const already = generation.asking.get(key);
    if (already) return already.promise;

    const local = generation.resolver.local?.(question) ?? ASK;
    if (local.kind === "answered") {
      generation.failed.delete(key);
      generation.answers.set(key, local.answer);
      return Promise.resolve(local.answer);
    }
    if (local.kind === "unasked") {
      generation.answers.delete(key);
      generation.failed.add(key);
      return Promise.resolve(null);
    }

    let settleWaiter: Request["settle"] = () => {};
    const promise = new Promise<LinkResolutionEntry | null>((done) => {
      settleWaiter = done;
    });
    const request: Request = {
      key,
      question,
      generation,
      promise,
      settle: settleWaiter,
      provisional: local.provisional,
      awaited: false,
    };
    generation.asking.set(key, request);
    generation.answers.set(key, local.provisional ?? PENDING);
    // Queued, not sent: the caller pumps once it has asked everything it has,
    // so one scan of the document goes out as one batch.
    generation.queue.push(request);
    return promise;
  };

  /** Ask on behalf of a `resolve()` caller, so retirement knows to carry it. */
  const askAwaited = (
    generation: Generation,
    key: string,
    question: LinkQuestion,
  ): Promise<LinkResolutionEntry | null> => {
    const promise = ask(generation, key, question);
    const request = generation.asking.get(key);
    if (request) request.awaited = true;
    pump(generation);
    return promise;
  };

  /**
   * Nothing this generation was asked can be answered any more. Queued
   * questions are dropped, and the ones already out are abandoned. A waiter
   * from `resolve()` is asked again in the live generation, if there is one;
   * every other waiter hears null now rather than a fact about a project state
   * that moved. Its answers go with the generation itself, which nothing can
   * reach again.
   */
  const retire = (generation: Generation) => {
    generation.queue.length = 0;
    const next = current !== generation ? current : null;
    for (const request of generation.asking.values()) {
      if (next && request.awaited) {
        void askAwaited(next, request.key, request.question).then(request.settle);
      } else request.settle(null);
    }
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

    get baseUri() {
      return current?.baseUri ?? null;
    },

    get binding() {
      return current?.binding ?? null;
    },

    read(link) {
      if (!current) return null;
      const internal = internalLink(link);
      return internal ? (current.answers.get(internal.key) ?? null) : null;
    },

    request(links) {
      const generation = current;
      if (!generation) return;
      let asked = false;
      for (const link of links) {
        const internal = internalLink(link);
        if (!internal) continue;
        if (generation.answers.has(internal.key) || generation.failed.has(internal.key)) continue;
        ask(generation, internal.key, internal.question);
        asked = true;
      }
      pump(generation);
      // Pending and local answers are states a renderer may show, so say them
      // once rather than per link — and never when nothing actually changed.
      if (asked) publish();
    },

    async resolve(link) {
      const generation = current;
      if (!generation) return null;
      const internal = internalLink(link);
      if (!internal) return null;
      const { key, question } = internal;
      const known = generation.answers.get(key);
      // A provisional answer is not settled: the click waits for the server
      // (whose gone or other document wins), or asks again if it failed.
      const settled = !generation.asking.has(key) && !generation.failed.has(key);
      if (known && known.state !== "pending" && settled) return known;
      // A click is the writer asking again, so a failure is worth retrying.
      generation.failed.delete(key);
      const answer = askAwaited(generation, key, question);
      if (generation.answers.get(key) !== known) publish();
      return answer;
    },

    registerResolver(resolve, options) {
      const previous = current;
      const baseUri = options?.baseUri ?? null;
      current = {
        resolver: resolve,
        baseUri,
        binding: {
          holderUri: baseUri,
          projectId: options?.projectId ?? null,
          index: resolve.index ?? null,
        },
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
      const generation = current;
      current = null;
      if (generation) retire(generation);
      listeners.clear();
    },
  };
}
