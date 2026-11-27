import {
  classifyWrittenSource,
  parseLinkRef,
  storedHref,
  storedLinkRef,
} from "@meridian/contracts";
import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";

import { uploads } from "@/core/uploads/upload-store";

import type { LinkAssignmentIndex, LinkAssignmentScope } from "./link-assignment";
import {
  classifyLinkTarget,
  isInternalLinkTarget,
  type LinkTarget,
  linkTargetHref,
} from "./link-target";

export type LinkKey = { ref: string | null; href: string };

export function linkKeyOfMark(attrs: { readonly [attribute: string]: unknown }): LinkKey {
  return { ref: storedLinkRef(attrs.ref), href: String(attrs.href ?? "") };
}

export function pictureKeyOfNode(attrs: { readonly [attribute: string]: unknown }): LinkKey | null {
  const src = String(attrs.src ?? "");
  const written = classifyWrittenSource(src);
  if (written.kind === "external") return null;
  const ref = storedLinkRef(attrs.ref);
  if (written.kind === "contextual") return { ref, href: src };
  return { ref, href: storedHref({ kind: written.target, uri: written.uri }, written.suffix) };
}

export function linkCacheKey(key: LinkKey): string {
  return `${key.ref ?? ""}\u0000${key.href}`;
}

type ResolvedFolderLink = { folderId: string; title: string; uri: string };

export function linkFolderId(
  entry: LinkResolutionEntry | null,
  link: Pick<LinkKey, "ref">,
): string | null {
  if (entry?.state === "folder") return entry.folder.folderId;
  const ref = parseLinkRef(link.ref);
  return ref?.kind === "folder" ? ref.folderId : null;
}

export type LinkDraftDestination = { draftId: string };

export type LinkResolutionEntry =
  | { state: "pending"; document: null }
  | { state: "document"; document: ResolvedDocumentLink; draft?: LinkDraftDestination }
  | { state: "folder"; document: null; folder: ResolvedFolderLink }
  | { state: "missing"; document: null }
  | { state: "gone"; document: null; trashedDocumentId?: string };

export type LinkAnswer = Exclude<LinkResolutionEntry, { state: "pending" }>;

export function goneLinkDocumentId(
  entry: LinkResolutionEntry | null,
  link: Pick<LinkKey, "ref">,
): string | null {
  if (entry?.state !== "gone") return null;
  if (entry.trashedDocumentId) return entry.trashedDocumentId;
  const ref = parseLinkRef(link.ref);
  return ref?.kind === "doc" ? ref.documentId : null;
}

export type LinkQuestion = { ref: string | null; target: LinkTarget };

export type LocalLinkAnswer =
  | { kind: "answered"; answer: LinkAnswer }
  | { kind: "unasked" }
  | { kind: "ask"; provisional: DocumentAnswer | null };

export type DocumentAnswer = Extract<LinkAnswer, { state: "document" }>;

export type InternalLinkResolver = {
  index?: LinkAssignmentIndex | null;
  local?: (question: LinkQuestion) => LocalLinkAnswer;
  remote: (questions: readonly LinkQuestion[]) => Promise<readonly (LinkAnswer | null)[]>;
};

export type LinkAnswerCache = {
  subscribe: (listener: (uploadsChanged?: ReadonlySet<string>) => void) => () => void;
  readonly available: boolean;
  readonly baseUri: string | null;
  readonly assignment: LinkAssignmentScope | null;
  read: (link: LinkKey) => LinkResolutionEntry | null;
  failed: (link: LinkKey) => boolean;
  request: (links: Iterable<LinkKey>) => void;
  resolve: (link: LinkKey) => Promise<LinkResolutionEntry | null>;
  registerResolver: (
    resolve: InternalLinkResolver,
    options?: { baseUri?: string | null; projectId?: string | null },
  ) => () => void;
  destroy: () => void;
};

const PENDING: LinkResolutionEntry = Object.freeze({ state: "pending", document: null });
const ASK: LocalLinkAnswer = Object.freeze({ kind: "ask", provisional: null });

function settledOver(
  provisional: DocumentAnswer | null,
  entry: LinkResolutionEntry | null,
): LinkResolutionEntry | null {
  if (!provisional) return entry;
  if (entry?.state === "gone") return entry;
  if (entry?.state === "document") {
    if (entry.document.documentId !== provisional.document.documentId) return entry;
    return entry.document.file
      ? { ...provisional, document: { ...provisional.document, file: entry.document.file } }
      : provisional;
  }
  return provisional;
}

const MAX_IN_FLIGHT = 4;
const MAX_BATCH = 200;

type Request = {
  readonly key: string;
  readonly question: LinkQuestion;
  readonly generation: Generation;
  readonly promise: Promise<LinkResolutionEntry | null>;
  readonly settle: (entry: LinkResolutionEntry | null) => void;
  readonly provisional: DocumentAnswer | null;
  awaited: boolean;
};

type Generation = {
  readonly resolver: InternalLinkResolver;
  readonly baseUri: string | null;
  readonly assignment: LinkAssignmentScope;
  readonly answers: Map<string, LinkResolutionEntry>;
  readonly failed: Set<string>;
  readonly asking: Map<string, Request>;
  readonly queue: Request[];
  running: number;
};

export function createLinkAnswerCache(): LinkAnswerCache {
  const listeners = new Set<() => void>();
  let current: Generation | null = null;

  const publish = () => {
    for (const listener of listeners) listener();
  };

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
    if (generation.asking.get(key) === request) generation.asking.delete(key);
    const previous = generation.answers.get(key) ?? null;
    if (answer) generation.failed.delete(key);
    else generation.failed.add(key);
    if (entry) generation.answers.set(key, entry);
    else generation.answers.delete(key);
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
    generation.queue.push(request);
    return promise;
  };

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
      const unsubscribeUploads = uploads.subscribe((changed) => listener(changed));
      return () => {
        listeners.delete(listener);
        unsubscribeUploads();
      };
    },

    get available() {
      return current !== null;
    },

    get baseUri() {
      return current?.baseUri ?? null;
    },

    get assignment() {
      return current?.assignment ?? null;
    },

    read(link) {
      if (!current) return null;
      const internal = internalLink(link);
      if (!internal) return null;
      const ref = parseLinkRef(link.ref);
      if (ref?.kind === "doc" && uploads.of(ref.documentId)) return null;
      return current.answers.get(internal.key) ?? null;
    },

    failed(link) {
      if (!current) return false;
      const internal = internalLink(link);
      return internal ? current.failed.has(internal.key) : false;
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
      if (asked) publish();
    },

    async resolve(link) {
      const generation = current;
      if (!generation) return null;
      const internal = internalLink(link);
      if (!internal) return null;
      const { key, question } = internal;
      const known = generation.answers.get(key);
      const settled = !generation.asking.has(key) && !generation.failed.has(key);
      if (known && known.state !== "pending" && settled) return known;
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
        assignment: {
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
