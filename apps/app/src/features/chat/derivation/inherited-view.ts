/**
 * A fork's inherited view: the source's turns through the cutoff, read once
 * from the transcript route's `inherited` range and never extended.
 *
 * Later source turns, compactions, and undos never reach it: the server clips
 * the source at the cutoff, so the read is the same every time. Owners name
 * where each turn came from (the source, or a thread further up for a fork of
 * a fork) and whether that thread is in the trash.
 */
import type { Thread, TranscriptPageResponse, Turn } from "@meridian/contracts/protocol";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { readThreadTranscript } from "@/client/api/threads-api";
import { useIsThreadPendingCreation } from "@/client/stores";
import type { InheritedTranscript } from "../transcript-model";

export type SourceOwner = {
  threadId: string;
  title: string | null;
  trashed: boolean;
};

export type InheritedView = {
  transcript: InheritedTranscript;
  owners: ReadonlyMap<string, SourceOwner>;
};

/** A page holds 200 turns; this bounds a runaway read at 20,000. */
const PAGE_LIMIT = 200;
const MAX_PAGES = 100;

export function inheritedQueryKey(threadId: string) {
  return ["threads", threadId, "inherited-transcript"] as const;
}

/** Folds transcript pages (oldest first) into turns with their owners. */
export function inheritedViewFromPages(pages: readonly TranscriptPageResponse[]): InheritedView {
  const turns: Turn[] = [];
  const ownerByTurnId = new Map<string, string>();
  const owners = new Map<string, SourceOwner>();
  for (const page of pages) {
    for (const owner of page.owners)
      owners.set(owner.threadId, {
        threadId: owner.threadId,
        title: owner.title,
        trashed: owner.trashed,
      });
    for (const entry of page.entries) {
      if (ownerByTurnId.has(entry.turn.id)) continue;
      turns.push({ ...entry.turn, blocks: entry.blocks });
      ownerByTurnId.set(entry.turn.id, entry.ownerThreadId);
    }
  }
  return { transcript: { turns, ownerByTurnId }, owners };
}

export function inheritedQueryOptions(threadId: string) {
  return queryOptions({
    queryKey: inheritedQueryKey(threadId),
    queryFn: async ({ signal }) => {
      const pages: TranscriptPageResponse[] = [];
      let cursor: string | undefined;
      for (let index = 0; index < MAX_PAGES; index += 1) {
        const page = await readThreadTranscript(
          threadId,
          {
            range: "inherited",
            order: "oldest_first",
            unit: "turn",
            limit: PAGE_LIMIT,
            ...(cursor ? { cursor } : {}),
          },
          signal,
        );
        pages.push(page);
        // A page stops at a segment boundary; the cursor continues past it.
        if (!page.hasMore || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return inheritedViewFromPages(pages);
    },
    // The prefix is frozen; only an owner's title or trash state can change.
    staleTime: 60_000,
  });
}

export type InheritedViewState = {
  view: InheritedView | null;
  /** The read failed and nothing stands in: the fork's history is missing, not empty. */
  failed: boolean;
  retry: () => void;
};

const NOT_A_FORK: InheritedViewState = { view: null, failed: false, retry: () => undefined };

/**
 * The inherited view for a fork, or null for any other thread. Until the
 * server can read it (the fork is still being created), `optimistic` stands
 * in: the source's own rows through the cutoff.
 */
export function useInheritedView(
  thread: Pick<Thread, "id" | "originType"> | null,
  optimistic: InheritedView | null,
): InheritedViewState {
  const isFork = thread?.originType === "fork";
  const pendingCreation = useIsThreadPendingCreation(thread?.id ?? null);
  const query = useQuery({
    ...inheritedQueryOptions(thread?.id ?? ""),
    enabled: isFork && !pendingCreation,
  });
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  if (!isFork) return NOT_A_FORK;
  const view = query.data ?? optimistic;
  return {
    view,
    failed: query.isError && view === null,
    retry,
  };
}

/**
 * What a new fork cut at `cutoffTurnId` inherits from the chat on screen: its
 * inherited rows and its own turns through the cutoff. Shown at once, then
 * replaced by the server's read, which has the same turns. That read carries
 * no model responses, so neither does this: a reply's Info would otherwise
 * appear, then vanish when the read lands.
 */
export function optimisticForkPrefix(input: {
  source: Pick<Thread, "id" | "title">;
  sourceInherited: InheritedView | null;
  localTurns: readonly Turn[];
  cutoffTurnId: string;
}): InheritedView | null {
  const { source, sourceInherited, localTurns, cutoffTurnId } = input;
  const inheritedTurns = sourceInherited?.transcript.turns ?? [];
  const all = [...inheritedTurns, ...localTurns];
  const cutoff = all.findIndex((turn) => turn.id === cutoffTurnId);
  if (cutoff < 0) return null;
  const turns = all
    .slice(0, cutoff + 1)
    .map((turn) => (turn.responses?.length ? { ...turn, responses: [] } : turn));
  const ownerByTurnId = new Map<string, string>();
  for (const turn of turns)
    ownerByTurnId.set(
      turn.id,
      sourceInherited?.transcript.ownerByTurnId.get(turn.id) ?? turn.threadId ?? source.id,
    );
  const owners = new Map(sourceInherited?.owners ?? []);
  owners.set(source.id, { threadId: source.id, title: source.title, trashed: false });
  return { transcript: { turns, ownerByTurnId }, owners };
}
