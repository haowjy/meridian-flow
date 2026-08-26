/** Paginated, virtualized associated-chat collection for a Work. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWorkThreads } from "@/client/query/useWorkThreads";
import { useAnnouncement } from "@/client/stores";
import { Button } from "@/components/ui/button";
import { ProjectChatRow } from "../chat-list/ProjectChatRow";
import { WorkResourceError } from "./WorkResourceState";

export function WorkAssociatedChats({
  projectId,
  work,
  scrollOwner,
  requestOpen,
}: {
  projectId: string;
  work: Work;
  scrollOwner: React.RefObject<HTMLDivElement | null>;
  requestOpen: (item: ProjectChatItem) => void;
}) {
  const query = useWorkThreads(projectId, work.id);
  const { announce, announceError } = useAnnouncement();
  const [now, setNow] = useState(Date.now());
  const [list, setList] = useState<HTMLUListElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [activeIds, setActiveIds] = useState<Set<string>>(() => new Set());
  const threadsRef = useRef(query.threads);
  threadsRef.current = query.threads;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useLayoutEffect(() => {
    if (!list) return;
    const measure = () => setScrollMargin(list.offsetTop);
    measure();
    const content = scrollOwner.current?.firstElementChild;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [list, scrollOwner]);

  const onActiveChange = useCallback((id: string, active: boolean) => {
    setActiveIds((current) => {
      if (current.has(id) === active) return current;
      const next = new Set(current);
      if (active) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indexes = new Set(defaultRangeExtractor(range));
      for (const id of activeIds) {
        const index = threadsRef.current?.findIndex((item) => item.id === id) ?? -1;
        if (index >= 0) indexes.add(index);
      }
      return [...indexes].sort((a, b) => a - b);
    },
    [activeIds],
  );
  const virtualizer = useVirtualizer({
    count: query.threads?.length ?? 0,
    getScrollElement: () => scrollOwner.current,
    estimateSize: () => 52,
    getItemKey: (index) => query.threads?.[index]?.id ?? index,
    overscan: 8,
    scrollMargin,
    rangeExtractor,
  });

  return (
    <section className="min-w-0 space-y-3">
      <h2 className="text-base font-semibold">{t`Associated chats`}</h2>
      {query.isError ? (
        <WorkResourceError label={t`Associated chats`} retry={query.refetch} />
      ) : query.threads === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : query.threads.length ? (
        <>
          <ul
            ref={setList}
            className="relative min-w-0"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = query.threads?.[virtualRow.index];
              return item ? (
                <li
                  key={item.id}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  aria-posinset={virtualRow.index + 1}
                  aria-setsize={query.threads?.length}
                  className="absolute top-0 left-0 w-full"
                  style={{
                    transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                  }}
                >
                  <ProjectChatRow
                    item={item}
                    now={now}
                    onOpen={requestOpen}
                    onActiveChange={onActiveChange}
                    onFavorite={(chat, value) => {
                      void query.setFavorite(chat.id, value).then((saved) => {
                        if (saved)
                          announce(
                            value
                              ? t`${chat.title} added to favorites`
                              : t`${chat.title} removed from favorites`,
                          );
                        else announceError(t`Favorite wasn’t saved`);
                      });
                    }}
                    onUnread={async (chat, value) => {
                      const saved = await query.setUnread(chat.id, value);
                      if (!saved) announceError(t`Read status wasn’t saved`);
                      return saved;
                    }}
                    getCommandState={query.getCommandState}
                  />
                </li>
              ) : null;
            })}
          </ul>
          {query.nextPageIdentity ? (
            <Button
              type="button"
              variant="outline"
              className="[@media(hover:none)]:min-h-11 [@media(pointer:coarse)]:min-h-11"
              disabled={query.isFetchingNextPage}
              onClick={() => {
                if (query.nextPageIdentity) query.fetchNextPageFor(query.nextPageIdentity);
              }}
            >
              {query.isFetchingNextPage ? <Trans>Loading…</Trans> : <Trans>Load more chats</Trans>}
            </Button>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          <Trans>No chats are associated with this Work.</Trans>
        </p>
      )}
    </section>
  );
}
