/**
 * Whether the documents a chat's writer messages reference still exist: what
 * an exact `@` reference chip draws (filled, or dashed and unfollowable once
 * its document is gone).
 *
 * One store per chat. Every user turn watches the document ids it references;
 * the store asks the availability lookup about every newly watched id in one
 * request per microtask (chunked to the endpoint's limit), and asks about
 * everything watched again when the chat's document catalog changes
 * (`refresh`), which is the same change that re-registers the chat's link
 * resolver. Per-turn lookups that never re-asked are why a deleted document
 * stayed filled until a reload.
 */

import {
  PROJECT_CONTEXT_AVAILABILITY_MAX_IDS,
  type ProjectContextIdentityLookupResult,
  type ProjectContextIdentityResolution,
} from "@meridian/contracts/protocol";
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";

import type { TranscriptReferenceResolution } from "@/rich-content/TranscriptReference";

type Lookup = (documentIds: readonly string[]) => Promise<ProjectContextIdentityLookupResult>;

export type ReferenceAvailability = {
  /** Look these ids up while shown; the return stops watching them. */
  watch(documentIds: readonly string[]): () => void;
  /** Ask about everything watched again: the documents changed. */
  refresh(): void;
  subscribe(listener: () => void): () => void;
  /** Every answer so far, keyed by document id. A new map after each change. */
  snapshot(): ReadonlyMap<string, TranscriptReferenceResolution>;
};

/**
 * What each exact reference draws, from the availability lookup. A document
 * that is gone for this writer (deleted, its Work or project deleted, or no
 * longer visible) is unavailable: a dashed chip that does not follow. An
 * indeterminate answer is left out, like a lookup still out or failed: not
 * settled, so the chip stays filled and does not follow.
 */
export function transcriptReferenceResolutions(
  resolutions: readonly ProjectContextIdentityResolution[],
): ReadonlyMap<string, TranscriptReferenceResolution> {
  const projected = new Map<string, TranscriptReferenceResolution>();
  for (const resolution of resolutions) {
    switch (resolution.kind) {
      case "available":
        projected.set(resolution.documentId, {
          documentId: resolution.documentId,
          uri: resolution.entry.uri,
          label: resolution.entry.name,
          available: true,
        });
        break;
      case "deleted":
      case "authority-unavailable":
      case "not-visible":
        projected.set(resolution.documentId, {
          documentId: resolution.documentId,
          available: false,
        });
        break;
      case "indeterminate":
        break;
    }
  }
  return projected;
}

const NOTHING: ReadonlyMap<string, TranscriptReferenceResolution> = new Map();

export function createReferenceAvailability(lookup: Lookup): ReferenceAvailability {
  const listeners = new Set<() => void>();
  const watched = new Map<string, number>();
  /** Ids to ask about at the next flush. */
  const due = new Set<string>();
  /** The latest question per id; an older answer arriving late is ignored. */
  const asked = new Map<string, number>();
  let answers: ReadonlyMap<string, TranscriptReferenceResolution> = NOTHING;
  let scheduled = false;
  let sequence = 0;

  const publish = () => {
    for (const listener of listeners) listener();
  };

  const settle = (
    ids: readonly string[],
    question: number,
    result: ProjectContextIdentityLookupResult,
  ) => {
    const current = ids.filter((id) => asked.get(id) === question);
    if (current.length === 0) return;
    const projected = transcriptReferenceResolutions(result.resolutions);
    const next = new Map(answers);
    for (const id of current) {
      const answer = projected.get(id);
      // Indeterminate is not settled: drop what was known rather than keep a
      // claim the server no longer makes.
      if (answer) next.set(id, answer);
      else next.delete(id);
    }
    answers = next;
    publish();
  };

  const flush = () => {
    scheduled = false;
    const ids = [...due].filter((id) => watched.has(id));
    due.clear();
    for (let start = 0; start < ids.length; start += PROJECT_CONTEXT_AVAILABILITY_MAX_IDS) {
      const chunk = ids.slice(start, start + PROJECT_CONTEXT_AVAILABILITY_MAX_IDS);
      const question = ++sequence;
      for (const id of chunk) asked.set(id, question);
      // A failed recheck keeps what was known: not settled is not gone.
      void lookup(chunk).then(
        (result) => settle(chunk, question, result),
        () => undefined,
      );
    }
  };

  const ask = (ids: Iterable<string>) => {
    for (const id of ids) due.add(id);
    if (scheduled || due.size === 0) return;
    scheduled = true;
    queueMicrotask(flush);
  };

  return {
    watch(documentIds) {
      const fresh: string[] = [];
      for (const id of new Set(documentIds)) {
        const count = watched.get(id) ?? 0;
        watched.set(id, count + 1);
        if (count === 0 && !answers.has(id) && !asked.has(id)) fresh.push(id);
      }
      ask(fresh);
      let watching = true;
      return () => {
        if (!watching) return;
        watching = false;
        for (const id of new Set(documentIds)) {
          const left = (watched.get(id) ?? 1) - 1;
          if (left > 0) watched.set(id, left);
          else watched.delete(id);
        }
      };
    },
    refresh() {
      ask(watched.keys());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => answers,
  };
}

export const ReferenceAvailabilityContext = createContext<ReferenceAvailability | null>(null);

/**
 * The exact-reference answers a user turn draws, for the ids it references.
 * Outside a chat that provides the store, nothing is known: chips stay filled
 * and do not follow.
 */
export function useReferenceAvailability(
  documentIds: readonly string[],
): ReadonlyMap<string, TranscriptReferenceResolution> {
  const store = useContext(ReferenceAvailabilityContext);
  const key = documentIds.join("\u0000");
  useEffect(() => {
    if (!store || !key) return;
    return store.watch(key.split("\u0000"));
  }, [store, key]);
  return useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.snapshot ?? nothing,
    nothing,
  );
}

const noSubscription = () => () => {};
const nothing = () => NOTHING;
