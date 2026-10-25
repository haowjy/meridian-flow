/**
 * Whether the documents and folders a chat's writer messages reference still
 * exist: what an exact `@` reference chip draws (filled, or dashed and
 * unfollowable once its document or folder is gone).
 *
 * One store per chat. Every user turn watches the identities it references
 * (`referenceKey`: a document id or a folder id, never confused); the store
 * asks the availability lookup about every newly watched one in one
 * request per microtask (chunked to the endpoint's limit), and asks about
 * everything watched again when the chat's document catalog changes
 * (`refresh`), which is the same change that re-registers the chat's link
 * resolver. Per-turn lookups that never re-asked are why a deleted document
 * stayed filled until a reload.
 *
 * An answer is current until a refresh or a failed question. A refresh asks
 * every watched id now and marks the rest stale: the transcript is
 * virtualized, so a turn scrolled away is unwatched, and it is asked again
 * when it scrolls back. A stale answer stays drawn until the new one lands, so
 * nothing flashes.
 *
 * Known limit: refresh follows the chat's own catalog revision (its Work's
 * linkable catalogs). A delete in another Work's Scratch, a Work deletion, or
 * a change in what this writer may see shows on the next catalog change or
 * on reload. Until then such a chip stays filled, and following it lands on
 * the destination's own "no longer available" answer. A precise signal would
 * be a document lifecycle event, not the catalog projection.
 */

import {
  PROJECT_CONTEXT_AVAILABILITY_MAX_IDS,
  type ProjectContextFolderResolution,
  type ProjectContextIdentityLookupResult,
  type ProjectContextIdentityResolution,
} from "@meridian/contracts/protocol";
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";

import {
  referenceKey,
  type TranscriptReferenceResolution,
} from "@/rich-content/TranscriptReference";

type Lookup = (identities: {
  documentIds: readonly string[];
  folderIds: readonly string[];
}) => Promise<ProjectContextIdentityLookupResult>;

export type ReferenceAvailability = {
  /** Look these identities up while shown; the return stops watching them. */
  watch(keys: readonly string[]): () => void;
  /** Ask about everything watched again: the documents changed. */
  refresh(): void;
  /**
   * The addresses the chat's own catalogs hold, by document id. An answer drawn at another
   * address was asked before the catalog respelled it (a New chat's upload gains its handle
   * once the server names the chat): ask again, once per address the catalog holds.
   */
  reconcile(held: ReadonlyMap<string, string>): void;
  subscribe(listener: () => void): () => void;
  /** Every answer so far, by `referenceKey`. A new map after each change. */
  snapshot(): ReadonlyMap<string, TranscriptReferenceResolution>;
};

/**
 * What each exact reference draws, from the availability lookup. A document
 * that is gone for this writer (deleted, its Work or project deleted, or no
 * longer visible) is unavailable: a dashed chip that does not follow. An
 * indeterminate answer is left out, like a lookup still out or failed: not
 * settled, so the chip stays filled and does not follow.
 */
function transcriptReferenceResolutions(
  resolutions: readonly ProjectContextIdentityResolution[],
  folderResolutions: readonly ProjectContextFolderResolution[],
): ReadonlyMap<string, TranscriptReferenceResolution> {
  const projected = new Map<string, TranscriptReferenceResolution>();
  for (const resolution of resolutions) {
    const key = referenceKey("document", resolution.documentId);
    switch (resolution.kind) {
      case "available":
        projected.set(key, {
          kind: "document",
          id: resolution.documentId,
          uri: resolution.entry.uri,
          label: resolution.entry.name,
          available: true,
        });
        break;
      case "deleted":
      case "authority-unavailable":
      case "not-visible":
        projected.set(key, { kind: "document", id: resolution.documentId, available: false });
        break;
      case "indeterminate":
        break;
    }
  }
  for (const resolution of folderResolutions) {
    const key = referenceKey("folder", resolution.folderId);
    switch (resolution.kind) {
      case "available":
        projected.set(key, {
          kind: "folder",
          id: resolution.folderId,
          uri: resolution.entry.uri,
          label: resolution.entry.name,
          available: true,
        });
        break;
      case "deleted":
      case "authority-unavailable":
      case "not-visible":
        projected.set(key, { kind: "folder", id: resolution.folderId, available: false });
        break;
      case "indeterminate":
        break;
    }
  }
  return projected;
}

const NOTHING: ReadonlyMap<string, TranscriptReferenceResolution> = new Map();

function sameAnswer(
  left: TranscriptReferenceResolution | undefined,
  right: TranscriptReferenceResolution | undefined,
): boolean {
  if (!left || !right) return left === right;
  if (!left.available || !right.available) return left.available === right.available;
  return left.uri === right.uri && left.label === right.label;
}

export function createReferenceAvailability(lookup: Lookup): ReferenceAvailability {
  const listeners = new Set<() => void>();
  const watched = new Map<string, number>();
  /** Ids to ask about at the next flush. */
  const due = new Set<string>();
  /** The latest question per id; an older answer arriving late is ignored. */
  const asked = new Map<string, number>();
  /** Ids whose answer is current or on its way: never asked again on watch. */
  const current = new Set<string>();
  /** The catalog address each id was last re-asked for, so a disagreeing server cannot loop. */
  const reconciled = new Map<string, string>();
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
    const settled = ids.filter((id) => asked.get(id) === question);
    if (settled.length === 0) return;
    const projected = transcriptReferenceResolutions(
      result.resolutions,
      result.folderResolutions ?? [],
    );
    const next = new Map(answers);
    let changed = false;
    for (const id of settled) {
      const answer = projected.get(id);
      // Indeterminate is not settled: drop what was known rather than keep a
      // claim the server no longer makes.
      if (!sameAnswer(next.get(id), answer)) changed = true;
      if (answer) next.set(id, answer);
      else next.delete(id);
    }
    // A recheck that found what was already drawn re-renders nothing.
    if (!changed) return;
    answers = next;
    publish();
  };

  /** A question that failed is not an answer: ask it again on the next watch or refresh. */
  const forget = (ids: readonly string[], question: number) => {
    for (const id of ids) {
      if (asked.get(id) !== question) continue;
      asked.delete(id);
      current.delete(id);
    }
  };

  const flush = () => {
    scheduled = false;
    const ids = [...due].filter((id) => watched.has(id));
    due.clear();
    for (let start = 0; start < ids.length; start += PROJECT_CONTEXT_AVAILABILITY_MAX_IDS) {
      const chunk = ids.slice(start, start + PROJECT_CONTEXT_AVAILABILITY_MAX_IDS);
      const question = ++sequence;
      for (const id of chunk) {
        asked.set(id, question);
        current.add(id);
      }
      // A failed question keeps what was known drawn (not settled is not
      // gone) and is asked again later.
      const of = (kind: "document" | "folder") =>
        chunk.flatMap((key) => (key.startsWith(`${kind}:`) ? [key.slice(kind.length + 1)] : []));
      void lookup({ documentIds: of("document"), folderIds: of("folder") }).then(
        (result) => settle(chunk, question, result),
        () => forget(chunk, question),
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
    watch(keys) {
      const fresh: string[] = [];
      for (const id of new Set(keys)) {
        const count = watched.get(id) ?? 0;
        watched.set(id, count + 1);
        if (count === 0 && !current.has(id)) fresh.push(id);
      }
      ask(fresh);
      let watching = true;
      return () => {
        if (!watching) return;
        watching = false;
        for (const id of new Set(keys)) {
          const left = (watched.get(id) ?? 1) - 1;
          if (left > 0) watched.set(id, left);
          else watched.delete(id);
        }
      };
    },
    refresh() {
      // Everything known is stale; what is shown is asked now, the rest when
      // it is shown again.
      current.clear();
      ask(watched.keys());
    },
    reconcile(held) {
      const stale: string[] = [];
      for (const id of watched.keys()) {
        const answer = answers.get(id);
        const uri = answer?.kind === "document" ? held.get(answer.id) : undefined;
        if (!answer?.available || !uri || answer.uri === uri) continue;
        if (reconciled.get(id) === uri) continue;
        reconciled.set(id, uri);
        current.delete(id);
        stale.push(id);
      }
      ask(stale);
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
 * The exact-reference answers a user turn draws, for the identities it
 * references. Outside a chat that provides the store, nothing is known: chips
 * stay filled and do not follow.
 */
export function useReferenceAvailability(
  keys: readonly string[],
): ReadonlyMap<string, TranscriptReferenceResolution> {
  const store = useContext(ReferenceAvailabilityContext);
  const key = keys.join("\u0000");
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
