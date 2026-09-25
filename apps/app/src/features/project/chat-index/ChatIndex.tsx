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
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProjectChatFeed } from "@/client/query/useProjectChatFeed";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Input } from "@/components/ui/input";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { CreationComposer } from "@/features/chat/CreationComposer";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { cn } from "@/lib/utils";
import { useChatRowCommands } from "../chat-list/useChatRowCommands";
import { useChatNavigation } from "../routing/chat-navigation";
import type { ProjectSearch } from "../routing/project-route";
import { ChatIndexList, type ChatIndexRowProps } from "./ChatIndexList";
import { ChatIndexLoading } from "./ChatIndexLoading";

type Filter = "all" | "favorites";
type Feed = ReturnType<typeof useProjectChatFeed>;
type ChatIndexUrlSearch = Pick<ProjectSearch, "filter" | "q">;

export type ChatIndexProps = {
  projectId: string;
  /** The host's chrome already reads "Chats" (the phone trail): less top space. */
  namedByChrome?: boolean;
};

/**
 * Filter and settled search live as router search params on this route, so
 * Back restores exactly what the writer left (no module-level state to leak
 * across projects or accounts).
 */
function useChatIndexSearch() {
  const search = useSearch({ strict: false }) as ChatIndexUrlSearch;
  const navigate = useNavigate();
  const filter: Filter = search.filter === "favorites" ? "favorites" : "all";
  const settledSearch = search.q ?? null;

  const setFilter = useCallback(
    (next: Filter) => {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => {
          const merged: Record<string, unknown> = { ...prev };
          if (next === "favorites") merged.filter = "favorites";
          else delete merged.filter;
          return merged;
        },
        replace: true,
      });
    },
    [navigate],
  );

  const setSearch = useCallback(
    (next: string | null) => {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => {
          const merged: Record<string, unknown> = { ...prev };
          if (next) merged.q = next;
          else delete merged.q;
          return merged;
        },
        replace: true,
      });
    },
    [navigate],
  );

  return { filter, settledSearch, setFilter, setSearch };
}

export function ChatIndex({ projectId, namedByChrome = false }: ChatIndexProps) {
  const { filter, settledSearch, setFilter, setSearch } = useChatIndexSearch();
  const feed = useProjectChatFeed(projectId, filter === "favorites", settledSearch);
  const now = useMinuteClock();
  const finePointer = useFinePointer();
  const { deleteDialog, onFavorite, onDelete, deleteFailure, retryDelete } =
    useChatRowCommands(projectId);
  const { openChat } = useChatNavigation();
  const onOpen = useCallback<ChatIndexRowProps["onOpen"]>(
    (item) => void openChat(item.id),
    [openChat],
  );
  const rowProps: ChatIndexRowProps = useMemo(
    () => ({ onFavorite, onDelete, now, onOpen }),
    [onFavorite, onDelete, now, onOpen],
  );
  const scrollOwner = useRef<HTMLDivElement>(null);

  return (
    // One scroll for the whole page; the list's tools stick once scrolled past.
    <div ref={scrollOwner} data-chat-index-scroll-owner className="app-scroll main-pane">
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
          <ChatSearchField value={settledSearch ?? ""} onSettle={setSearch} />
          <ChatFilter value={filter} onChange={setFilter} />
        </div>
        <div className="mt-[clamp(0.5rem,2vh,1.25rem)]">
          <ChatIndexBody
            projectId={projectId}
            feed={feed}
            favorites={filter === "favorites"}
            search={settledSearch}
            scrollOwner={scrollOwner}
            rowProps={rowProps}
            deleteFailure={deleteFailure}
            retryDelete={retryDelete}
          />
        </div>
      </div>
      {deleteDialog}
    </div>
  );
}

/**
 * Keystroke-local search text, decoupled from the list's parent: only the
 * settled (debounced) value is reported up, so typing never re-renders every
 * row. Resyncs from an external `value` change (Back/Forward) without
 * clobbering a value the writer is still typing.
 */
function ChatSearchField({
  value,
  onSettle,
}: {
  value: string;
  onSettle: (value: string | null) => void;
}) {
  const [text, setText] = useState(value);
  const lastSettled = useRef(value);
  useEffect(() => {
    if (value !== lastSettled.current) {
      lastSettled.current = value;
      setText(value);
    }
  }, [value]);
  useEffect(() => {
    const next = text.trim();
    const timer = window.setTimeout(
      () => {
        lastSettled.current = next;
        onSettle(next || null);
      },
      next ? 200 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [text, onSettle]);

  return (
    <div className="relative min-w-0 flex-1">
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        value={text}
        aria-label={t`Search chats`}
        placeholder={t`Search chats`}
        onChange={(event) => setText(event.target.value)}
        className="h-8 pl-8 [@media(pointer:coarse)]:h-11"
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
  search,
  scrollOwner,
  rowProps,
  deleteFailure,
  retryDelete,
}: {
  projectId: string;
  feed: Feed;
  favorites: boolean;
  search: string | null;
  scrollOwner: React.RefObject<HTMLElement | null>;
  rowProps: ChatIndexRowProps;
  deleteFailure: ReturnType<typeof useChatRowCommands>["deleteFailure"];
  retryDelete: () => void;
}) {
  // A true first load has nothing cached yet; a settled search or Favorites
  // switch keeps the previous rows on screen (`keepPreviousData`) while the
  // new page fetches, so only the genuine first load shows the skeleton.
  if (feed.isPending) return <ChatIndexLoading />;
  if (feed.isError && !feed.data)
    return (
      <InlineErrorRow
        message={<Trans>Couldn't load chats.</Trans>}
        onRetry={() => void feed.refetch()}
      />
    );
  // Suppress the terminal empty state while settling on stale placeholder
  // data: it may belong to a different filter/search than the one displayed.
  if (!feed.items.length && !feed.hasNextPage && !feed.isPlaceholderData)
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
      <ChatIndexList
        projectId={projectId}
        items={feed.items}
        complete={!feed.hasNextPage}
        busy={feed.isFetching}
        scrollOwner={scrollOwner}
        rowProps={rowProps}
        deleteFailure={deleteFailure}
        retryDelete={retryDelete}
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
