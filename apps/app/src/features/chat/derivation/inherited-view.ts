import type { Thread, TranscriptPageResponse, Turn } from "@meridian/contracts/protocol";
import { inConversation } from "@meridian/contracts/threads";
import type { InheritedTranscript } from "@meridian/thread-client";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { readThreadTranscript } from "@/client/api/threads-api";
import { useIsThreadPendingCreation } from "@/client/stores";

export type SourceOwner = {
  threadId: string;
  title: string | null;
  trashed: boolean;
};

export type InheritedView = {
  transcript: InheritedTranscript;
  owners: ReadonlyMap<string, SourceOwner>;
};

const PAGE_LIMIT = 200;
const MAX_PAGES = 100;

export function inheritedQueryKey(threadId: string) {
  return ["threads", threadId, "inherited-transcript"] as const;
}

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
        if (!page.hasMore || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return inheritedViewFromPages(pages);
    },
    staleTime: 60_000,
  });
}

export type InheritedViewState = {
  view: InheritedView | null;
  failed: boolean;
  retry: () => void;
};

const NOT_A_FORK: InheritedViewState = { view: null, failed: false, retry: () => undefined };

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

export function optimisticForkPrefix(input: {
  source: Pick<Thread, "id" | "title">;
  sourceInherited: InheritedView | null;
  localTurns: readonly Turn[];
  cutoffTurnId: string;
}): InheritedView | null {
  const { source, sourceInherited, localTurns, cutoffTurnId } = input;
  const inheritedTurns = sourceInherited?.transcript.turns ?? [];
  const all = [...inheritedTurns, ...localTurns.filter(inConversation)];
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
