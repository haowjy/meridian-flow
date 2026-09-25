/**
 * ChatIndex — the project's chats page: the new-chat composer, then every
 * top-level chat, latest activity first, grouped Today / Yesterday / Earlier
 * behind a title search and an All | Favorites filter.
 *
 * Same family as the Editor's Recently opened (recency groups, quiet failure).
 * It renders only as the Chat screen's page: the center project root and the
 * phone. The page scrolls as one; the search and filter row sticks.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useProjectChatFeed } from "@/client/query/useProjectChatFeed";
import { useProjectChatUserState } from "@/client/query/useProjectChatUserState";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Input } from "@/components/ui/input";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { CreationComposer } from "@/features/chat/CreationComposer";
import { cn } from "@/lib/utils";
import { ProjectChatRow, type ProjectChatRowProps } from "../chat-list/ProjectChatRow";
import { useChatRowCommands } from "../chat-list/useChatRowCommands";
import { RecencyGroupedList, useMinuteClock } from "../RecencyGroupedList";
import { ChatIndexLoading } from "./ChatIndexLoading";

type Filter = "all" | "favorites";
type RowProps = Omit<ProjectChatRowProps, "item" | "favorite">;
type Feed = ReturnType<typeof useProjectChatFeed>;

export type ChatIndexProps = {
  projectId: string;
  onOpenThread: (threadId: string) => void;
  /** The host's chrome already reads "Chats" (the phone trail): less top space. */
  namedByChrome?: boolean;
};

export function ChatIndex({ projectId, onOpenThread, namedByChrome = false }: ChatIndexProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [searchText, setSearchText] = useState("");
  const search = useSettledSearch(searchText);
  const feed = useProjectChatFeed(projectId, filter === "favorites", search);
  const now = useMinuteClock();
  const finePointer = useFinePointer();
  const { deleteDialog, ...commands } = useChatRowCommands(projectId);
  const rowProps: RowProps = { ...commands, now, onOpen: (item) => onOpenThread(item.id) };

  return (
    // One scroll for the whole page; the list's tools stick once scrolled past.
    <div data-chat-index-scroll-owner className="app-scroll main-pane">
      <div
        className={cn(
          "chat-column @container/project-screen pb-12",
          namedByChrome ? "pt-4" : "pt-[clamp(1rem,9vh,5rem)]",
        )}
      >
        <h1 className="mb-[clamp(0.75rem,3vh,1.25rem)] text-center text-xl font-normal tracking-tight text-balance text-foreground">
          <Trans>What will you write next?</Trans>
        </h1>
        <CreationComposer projectId={projectId} variant="hero" autoFocus={finePointer} />
        <div className="sticky top-0 z-10 mt-[clamp(1rem,4vh,2rem)] flex items-center gap-3 bg-background py-2">
          <h2 className="sr-only">
            <Trans>Chats</Trans>
          </h2>
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={searchText}
              aria-label={t`Search chats`}
              placeholder={t`Search chats`}
              onChange={(event) => setSearchText(event.target.value)}
              className="h-8 pl-8 [@media(pointer:coarse)]:h-11"
            />
          </div>
          <ChatFilter value={filter} onChange={setFilter} />
        </div>
        <div className="mt-[clamp(0.5rem,2vh,1.25rem)]">
          <ChatIndexBody
            projectId={projectId}
            feed={feed}
            favorites={filter === "favorites"}
            search={search}
            rowProps={rowProps}
          />
        </div>
      </div>
      {deleteDialog}
    </div>
  );
}

/** Search as typed, settled briefly so each keystroke is not its own request. */
function useSettledSearch(text: string): string | null {
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    const next = text.trim() || null;
    const timer = window.setTimeout(() => setSettled(next), next ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [text]);
  return settled;
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
  search,
  rowProps,
}: {
  projectId: string;
  feed: Feed;
  favorites: boolean;
  search: string | null;
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
        {search ? (
          <Trans>No chats match “{search}”.</Trans>
        ) : favorites ? (
          <Trans>No favorite chats yet.</Trans>
        ) : (
          <Trans>No chats yet.</Trans>
        )}
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

/**
 * Infinite pagination: a sentinel near the end requests the next page. The
 * observer exists only while a page can be requested, and each page it loads
 * re-observes, so a tall viewport keeps filling until the sentinel leaves it.
 */
function NextPage({ feed }: { feed: Feed }) {
  const sentinel = useRef<HTMLDivElement>(null);
  const { fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } = feed;
  const pages = feed.data?.pages.length;
  useEffect(() => {
    if (!sentinel.current || !hasNextPage || isFetchingNextPage || isFetchNextPageError) return;
    let active = true;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!active || !entry?.isIntersecting) return;
        active = false;
        void fetchNextPage();
      },
      { rootMargin: "240px" },
    );
    observer.observe(sentinel.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError, pages]);

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
