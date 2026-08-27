/** Paginated, virtualized associated-chat collection for a Work. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
import { useEffect, useState } from "react";
import { useProjectChatUserState } from "@/client/query/useProjectChatUserState";
import { useWorkThreads } from "@/client/query/useWorkThreads";
import { useAnnouncement } from "@/client/stores";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { ProjectChatRow } from "../chat-list/ProjectChatRow";
import { useExternalScrollVirtualList } from "./useExternalScrollVirtualList";

const chatKey = (item: ProjectChatItem) => item.id;
const estimateChatRow = () => 52;

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
  const threads = query.threads ?? [];
  const { listRef, onActiveChange, virtualizer } = useExternalScrollVirtualList({
    items: threads,
    scrollOwner,
    getItemKey: chatKey,
    estimateSize: estimateChatRow,
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      {query.isError ? (
        <InlineErrorRow
          message={t`Associated chats couldn’t load`}
          onRetry={query.refetch}
          actionLabel={t`Retry Associated chats`}
        />
      ) : query.threads === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : query.threads.length ? (
        <>
          <ul
            ref={listRef}
            className="relative min-w-0"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = threads[virtualRow.index];
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
                  <WorkChatRow
                    projectId={projectId}
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
    </>
  );
}

function WorkChatRow({
  projectId,
  item,
  now,
  onOpen,
  onActiveChange,
  onFavorite,
}: {
  projectId: string;
  item: ProjectChatItem;
  now: number;
  onOpen: (item: ProjectChatItem) => void;
  onActiveChange: (id: string, active: boolean) => void;
  onFavorite: (item: ProjectChatItem, value: boolean) => void;
}) {
  const state = useProjectChatUserState(projectId, item);
  return (
    <ProjectChatRow
      {...state}
      now={now}
      onOpen={onOpen}
      onActiveChange={onActiveChange}
      onFavorite={onFavorite}
    />
  );
}
