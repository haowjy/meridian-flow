/** Paginated, virtualized associated-chat collection for a Work. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
import { useWorkThreads } from "@/client/query/useWorkThreads";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { useExternalScrollVirtualList } from "@/hooks/use-external-scroll-virtual-list";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { ProjectChatFeedRow } from "../chat-list/ProjectChatRow";
import { useChatRowCommands } from "../chat-list/useChatRowCommands";

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
  const { deleteDialog, onFavorite, onDelete, deleteFailure, retryDelete } =
    useChatRowCommands(projectId);
  const now = useMinuteClock();
  const threads = query.threads ?? [];
  const { listRef, onActiveChange, virtualizer } = useExternalScrollVirtualList({
    items: threads,
    scrollOwner,
    getItemKey: chatKey,
    estimateSize: estimateChatRow,
  });

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
              if (!item) return null;
              const deleteError =
                deleteFailure?.id === item.id
                  ? { error: deleteFailure.error, onRetry: retryDelete }
                  : undefined;
              return (
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
                  <ProjectChatFeedRow
                    projectId={projectId}
                    item={item}
                    now={now}
                    onOpen={requestOpen}
                    onActiveChange={onActiveChange}
                    onFavorite={onFavorite}
                    onDelete={onDelete}
                    deleteError={deleteError}
                  />
                </li>
              );
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
      {deleteDialog}
    </>
  );
}
