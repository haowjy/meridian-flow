/**
 * ChatIndex — the project's chats: every top-level chat, latest activity first,
 * grouped Today / Yesterday / Earlier behind an All | Favorites filter.
 *
 * Same family as the Editor's Recently opened (heading row with the create
 * action, recency groups, quiet failure). It renders in whichever pane asked
 * for it — the center project root, the dock body, the phone — and never hosts
 * a composer: New chat opens the empty chat in that same pane through the
 * route command.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { MessageSquarePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type ProjectFeedNextPageIdentity,
  useProjectChatFeed,
} from "@/client/query/useProjectChatFeed";
import { useProjectChatUserState } from "@/client/query/useProjectChatUserState";
import { useAnnouncement } from "@/client/stores";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  ProjectChatRow,
  type ProjectChatRowProps,
  ProjectChatRowSkeleton,
} from "../chat-list/ProjectChatRow";
import { RecencyGroupedList, useMinuteClock } from "../RecencyGroupedList";
import { useOpenNewChatRoute } from "../routing/ProjectNavigationContext";

type Filter = "all" | "favorites";
type RowProps = Omit<ProjectChatRowProps, "item" | "favorite">;
type Feed = ReturnType<typeof useProjectChatFeed>;

export type ChatIndexProps = {
  projectId: string;
  onOpenThread: (threadId: string) => void;
  /** `page` — the pane's whole screen (center, phone). `rail` — the dock body. */
  placement: "page" | "rail";
  /**
   * The host's chrome already reads "Chats" (the phone trail): the heading
   * stays for screen readers only and the filter takes its place in the row.
   */
  namedByChrome?: boolean;
};

export function ChatIndex({
  projectId,
  onOpenThread,
  placement,
  namedByChrome = false,
}: ChatIndexProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const feed = useProjectChatFeed(projectId, filter === "favorites");
  const openNewChat = useOpenNewChatRoute();
  const { announce, announceError } = useAnnouncement();
  const now = useMinuteClock();
  const rowProps: RowProps = {
    now,
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
  const newChat = openNewChat ? () => void openNewChat() : undefined;
  const Heading = placement === "page" ? "h1" : "h2";

  // A project with no chats has nothing to filter: the first-run state stands
  // alone rather than sitting under a heading that promises a list.
  if (
    filter === "all" &&
    !feed.isPending &&
    !feed.isError &&
    !feed.items.length &&
    !feed.hasNextPage
  ) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 text-center">
        <p className="font-medium text-foreground">
          <Trans>No chats yet</Trans>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          <Trans>Chats you start in this project collect here.</Trans>
        </p>
        <NewChatButton onClick={newChat} className="mt-5" />
      </div>
    );
  }

  return (
    <div data-chat-index-scroll-owner className="app-scroll main-pane">
      <div
        className={cn(
          "chat-column @container/project-screen",
          namedByChrome ? "pt-4 pb-12" : placement === "page" ? "pt-16 pb-24" : "pt-5 pb-12",
        )}
      >
        {namedByChrome ? (
          <div className="flex items-center justify-between gap-4">
            <Heading className="sr-only">
              <Trans>Chats</Trans>
            </Heading>
            <ChatFilter value={filter} onChange={setFilter} />
            <NewChatButton onClick={newChat} />
          </div>
        ) : (
          // One row when it fits; in a narrow dock the filter drops beneath the
          // heading so New chat keeps its place at the row's end.
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 @[26rem]/project-screen:grid-cols-[auto_minmax(0,1fr)_auto]">
            <Heading className="text-headline-section text-foreground">
              <Trans>Chats</Trans>
            </Heading>
            <ChatFilter
              value={filter}
              onChange={setFilter}
              className="col-span-2 row-start-2 justify-self-start @[26rem]/project-screen:col-span-1 @[26rem]/project-screen:col-start-2 @[26rem]/project-screen:row-start-1"
            />
            <NewChatButton
              onClick={newChat}
              className="col-start-2 row-start-1 @[26rem]/project-screen:col-start-3"
            />
          </div>
        )}
        <div className="mt-7">
          <ChatIndexBody
            projectId={projectId}
            feed={feed}
            favorites={filter === "favorites"}
            rowProps={rowProps}
          />
        </div>
      </div>
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

function NewChatButton({ onClick, className }: { onClick?: () => void; className?: string }) {
  return (
    <Button
      size="sm"
      className={cn("[@media(pointer:coarse)]:min-h-11", className)}
      onClick={onClick}
      disabled={!onClick}
    >
      <MessageSquarePlus aria-hidden />
      <Trans>New chat</Trans>
    </Button>
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

/** Loading anatomy matches a first group: its label, then rows at real rhythm. */
export function ChatIndexLoading() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">
        <Trans>Loading chats</Trans>
      </span>
      <div aria-hidden>
        <Skeleton className="h-3 w-14 motion-reduce:animate-none" />
        <ul className="-mx-2 mt-2 divide-y divide-border-subtle">
          {Array.from({ length: 5 }, (_, index) => (
            <ProjectChatRowSkeleton key={index} />
          ))}
        </ul>
      </div>
    </div>
  );
}
