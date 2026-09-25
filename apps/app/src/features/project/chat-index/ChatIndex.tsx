/**
 * ChatIndex — the project's chats page: the new-chat composer, then every
 * top-level chat, latest activity first, grouped Today / Yesterday / Earlier
 * behind an All | Favorites filter.
 *
 * Same family as the Editor's Recently opened (recency groups, quiet failure).
 * It renders only as the Chat screen's page: the center project root and the
 * phone. The page scrolls as one.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { useEffect, useRef, useState } from "react";
import { useDeleteChat } from "@/client/query/useDeleteChat";
import {
  type ProjectFeedNextPageIdentity,
  useProjectChatFeed,
} from "@/client/query/useProjectChatFeed";
import { useProjectChatUserState } from "@/client/query/useProjectChatUserState";
import { useAnnouncement } from "@/client/stores";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { CreationComposer } from "@/features/chat/CreationComposer";
import { cn } from "@/lib/utils";
import { DeleteChatDialog } from "../chat-list/DeleteChatDialog";
import { ProjectChatRow, type ProjectChatRowProps } from "../chat-list/ProjectChatRow";
import { RecencyGroupedList, useMinuteClock } from "../RecencyGroupedList";
import { useProjectChatNavigation } from "../routing/ProjectNavigationContext";
import { ChatIndexLoading } from "./ChatIndexLoading";

type Filter = "all" | "favorites";
type RowProps = Omit<ProjectChatRowProps, "item" | "favorite">;
type Feed = ReturnType<typeof useProjectChatFeed>;

export type ChatIndexProps = {
  projectId: string;
  onOpenThread: (threadId: string) => void;
  /**
   * The host's chrome already reads "Chats" (the phone trail): the heading
   * stays for screen readers only and the filter takes its place in the row.
   */
  namedByChrome?: boolean;
};

export function ChatIndex({ projectId, onOpenThread, namedByChrome = false }: ChatIndexProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const feed = useProjectChatFeed(projectId, filter === "favorites");
  const { announce, announceError } = useAnnouncement();
  const now = useMinuteClock();
  const finePointer = useFinePointer();
  const navigation = useProjectChatNavigation();
  const deletion = useDeleteChat(projectId, (threadId) => {
    navigation?.forgetChat?.(threadId);
    announce(t`Chat deleted`);
  });
  const rowProps: RowProps = {
    now,
    onDelete: (item) => deletion.request({ id: item.id, title: item.title || t`New chat` }),
    onOpen: (item) => onOpenThread(item.id),
    onFavorite: (item, value) => {
      void feed.setFavorite(item.id, value).then((saved) => {
        if (saved)
          announce(
            value ? t`${item.title} added to Favorites` : t`${item.title} removed from Favorites`,
          );
        else announceError(t`Favorite wasn’t saved`);
      });
    },
  };

  return (
    <div className="main-pane flex h-full min-h-0 flex-col">
      {/* One scroll for the whole page. The scroll box is the column itself, so
          its scrollbar sits at the rows' edge rather than the pane's. */}
      <div className="chat-column @container/project-screen flex min-h-0 flex-1 flex-col">
        <div
          data-chat-index-scroll-owner
          className={cn(
            "app-scroll -mr-4 pr-4 pb-12",
            namedByChrome ? "pt-4" : "pt-[clamp(1rem,9vh,5rem)]",
          )}
        >
          <h1 className="mb-[clamp(0.75rem,3vh,1.25rem)] text-center text-xl font-normal tracking-tight text-balance text-foreground">
            <Trans>What will you write next?</Trans>
          </h1>
          <CreationComposer projectId={projectId} variant="hero" autoFocus={finePointer} />
          <div className="mt-[clamp(1.5rem,5vh,2.5rem)] flex items-center gap-4">
            <h2 className={namedByChrome ? "sr-only" : "text-headline-section text-foreground"}>
              <Trans>Chats</Trans>
            </h2>
            <ChatFilter value={filter} onChange={setFilter} />
          </div>
          <div className="mt-[clamp(0.75rem,3vh,1.75rem)]">
            <ChatIndexBody
              projectId={projectId}
              feed={feed}
              favorites={filter === "favorites"}
              rowProps={rowProps}
            />
          </div>
        </div>
      </div>
      <DeleteChatDialog
        target={deletion.target}
        isPending={deletion.isPending}
        error={deletion.error}
        onCancel={deletion.cancel}
        onConfirm={deletion.confirm}
      />
    </div>
  );
}

function ChatFilter({
  value,
  onChange,
  className,
}: {
  value: Filter;
  onChange: (value: Filter) => void;
  className?: string;
}) {
  return (
    <SegmentedTabs
      label={t`Show chats`}
      value={value}
      onChange={onChange}
      options={[
        { value: "all", label: <Trans>All</Trans> },
        { value: "favorites", label: <Trans>Favorites</Trans> },
      ]}
      className={className}
    />
  );
}

function ChatIndexBody({
  projectId,
  feed,
  favorites,
  rowProps,
}: {
  projectId: string;
  feed: Feed;
  favorites: boolean;
  rowProps: RowProps;
}) {
  if (feed.isPending) return <ChatIndexLoading />;
  if (feed.isError && !feed.data)
    return (
      <InlineErrorRow
        message={<Trans>Couldn't load chats.</Trans>}
        onRetry={() => void feed.refetch()}
      />
    );
  if (!feed.items.length && !feed.hasNextPage)
    return (
      <p className="text-sm text-muted-foreground">
        {favorites ? <Trans>No favorite chats yet.</Trans> : <Trans>No chats yet.</Trans>}
      </p>
    );
  return (
    <>
      <RecencyGroupedList
        items={feed.items}
        now={rowProps.now}
        timestamp={(item) => item.lastActivityAt}
        itemKey={(item) => item.id}
        busy={feed.isFetchingNextPage}
        // Rows own a hover wash with inner padding; bleed it so row text lines
        // up with the heading and group labels.
        listClassName="-mx-2"
        renderItem={(item) => (
          <ChatIndexRow projectId={projectId} item={item} rowProps={rowProps} />
        )}
      />
      <NextPage feed={feed} />
      {/* A failed refresh over cached rows keeps the list and offers a quiet
          retry; a failed first load has nothing to show. */}
      {feed.isError && !feed.isFetchNextPageError ? (
        <p className="mt-5 text-xs text-muted-foreground">
          <Trans>Couldn't refresh chats.</Trans>{" "}
          <button type="button" onClick={() => void feed.refetch()} className="text-button text-xs">
            <Trans>Retry</Trans>
          </button>
        </p>
      ) : null}
    </>
  );
}

function ChatIndexRow({
  projectId,
  item,
  rowProps,
}: {
  projectId: string;
  item: ProjectChatItem;
  rowProps: RowProps;
}) {
  const state = useProjectChatUserState(projectId, item);
  return <ProjectChatRow {...rowProps} {...state} />;
}

/** Infinite pagination: a sentinel near the end requests each cursor once. */
function NextPage({ feed }: { feed: Feed }) {
  const sentinel = useRef<HTMLDivElement>(null);
  const requestedPage = useRef<ProjectFeedNextPageIdentity | null>(null);
  useEffect(() => {
    if (
      !sentinel.current ||
      !feed.hasNextPage ||
      !feed.nextPageIdentity ||
      feed.isFetchingNextPage ||
      feed.isFetchNextPageError
    )
      return;
    const pageIdentity = feed.nextPageIdentity;
    let active = true;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!active) return;
        if (entry?.isIntersecting && requestedPage.current !== pageIdentity) {
          requestedPage.current = pageIdentity;
          void feed.fetchNextPage();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(sentinel.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [
    feed.fetchNextPage,
    feed.hasNextPage,
    feed.isFetchNextPageError,
    feed.isFetchingNextPage,
    feed.nextPageIdentity,
  ]);

  if (feed.isFetchNextPageError)
    return (
      <div className="mt-2">
        <InlineErrorRow
          message={<Trans>More chats couldn't load.</Trans>}
          onRetry={() => void feed.fetchNextPage()}
        />
      </div>
    );
  return (
    <>
      {feed.isFetchingNextPage ? (
        <span role="status" className="sr-only">
          <Trans>Loading more chats</Trans>
        </span>
      ) : null}
      <div ref={sentinel} data-chat-feed-sentinel aria-hidden className="h-px" />
    </>
  );
}

/** Autofocus the page composer only where a hardware keyboard is likely. */
function useFinePointer(): boolean {
  const [fine, setFine] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.("(hover: hover) and (pointer: fine)");
    if (!media) return;
    const sync = () => setFine(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return fine;
}
