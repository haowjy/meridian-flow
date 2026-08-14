/** Chat-first project Home: one container-responsive, server-projected conversation feed. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { HomeChatItem } from "@meridian/contracts/protocol";
import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useHomeChatFeed } from "@/client/query/useHomeChatFeed";
import { useAnnouncement } from "@/client/stores";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCreateChat } from "../chat/use-create-chat";
import { HomeChatCard } from "./HomeChatCard";
import { HomeFeedSection } from "./HomeFeed";
import { useHomeFavoriteMovement } from "./use-home-favorite-movement";

export type HomeScreenProps = { projectId: string; onSelectThread: (threadId: string) => void };

export function HomeScreen({ projectId, onSelectThread }: HomeScreenProps) {
  const feed = useHomeChatFeed(projectId);
  const creation = useCreateChat(projectId, onSelectThread);
  const { announce, announceError } = useAnnouncement();
  const sentinel = useRef<HTMLDivElement>(null);
  const movement = useHomeFavoriteMovement(feed.grouped);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (
      !sentinel.current ||
      !feed.hasNextPage ||
      feed.isFetchingNextPage ||
      feed.isFetchNextPageError
    )
      return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void feed.fetchNextPage();
      },
      { rootMargin: "240px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [feed.fetchNextPage, feed.hasNextPage, feed.isFetchNextPageError, feed.isFetchingNextPage]);

  if (feed.isPending) return <HomeLoading />;
  if (feed.isError && !feed.data)
    return (
      <HomeState
        role="alert"
        title={t`Chats couldn’t load`}
        caption={t`Check your connection and try again.`}
        action={
          <Button variant="outline" onClick={() => void feed.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        }
      />
    );
  const { continueChat, favorites, recent } = feed.grouped;
  if (!continueChat && favorites.length === 0 && recent.length === 0) {
    return (
      <HomeState
        title={t`Start a chat`}
        caption={t`Your conversations will appear here.`}
        action={<NewChatButton {...creation} />}
        error={
          creation.createError ? (
            <InlineErrorRow message={creation.createError.message} onRetry={creation.createChat} />
          ) : undefined
        }
      />
    );
  }
  const cardProps = {
    now,
    onOpen: (item: HomeChatItem) => {
      if (item.attention !== "none") feed.setUnread(item.id, false);
      onSelectThread(item.id);
    },
    onFavorite: (item: HomeChatItem, value: boolean, keyboard: boolean) => {
      movement.capture(item.id, keyboard);
      void feed.setFavorite(item.id, value).then((saved) => {
        if (saved)
          announce(
            value
              ? t`${item.title} moved to Favorite chats`
              : t`${item.title} moved to Recent chats`,
          );
        else {
          movement.capture(item.id, keyboard);
          announceError(t`Favorite wasn’t saved`);
        }
      });
    },
    onUnread: feed.setUnread,
    getCommandState: feed.getCommandState,
  };
  return (
    <div ref={movement.scrollRef} className="app-scroll">
      <div className="project-screen-column gap-8">
        <h1 className="sr-only">
          <Trans>Home</Trans>
        </h1>
        <section className="flex flex-col gap-3">
          <div className="flex min-h-9 items-center justify-between gap-4">
            <h2 className="text-headline-section">
              <Trans>Continue</Trans>
            </h2>
            <NewChatButton {...creation} />
          </div>
          {creation.createError ? (
            <InlineErrorRow message={creation.createError.message} onRetry={creation.createChat} />
          ) : null}
          {continueChat ? (
            <HomeChatCard item={continueChat} variant="continue" {...cardProps} />
          ) : null}
        </section>
        {favorites.length ? (
          <HomeFeedSection title={t`Favorite chats`} items={favorites} cardProps={cardProps} />
        ) : null}
        {recent.length || feed.hasNextPage ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-headline-section">
              <Trans>Recent chats</Trans>
            </h2>
            <ul
              className="grid grid-cols-1 gap-4 @2xl/project-home:grid-cols-2"
              aria-busy={feed.isFetchingNextPage || undefined}
            >
              {recent.map((item) => (
                <li key={item.id}>
                  <HomeChatCard item={item} {...cardProps} />
                </li>
              ))}
            </ul>
            {feed.isFetchingNextPage ? (
              <span role="status" className="sr-only">
                <Trans>Loading more chats</Trans>
              </span>
            ) : null}
            {feed.isFetchNextPageError ? (
              <div
                role="alert"
                className="col-span-full flex items-center justify-center gap-2 text-sm text-muted-foreground"
              >
                <Trans>More chats couldn’t load.</Trans>
                <Button variant="link" onClick={() => void feed.fetchNextPage()}>
                  <Trans>Retry</Trans>
                </Button>
              </div>
            ) : (
              <div ref={sentinel} aria-hidden className="h-px" />
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function NewChatButton({ createChat, creating }: ReturnType<typeof useCreateChat>) {
  return (
    <Button
      className="min-w-32"
      type="button"
      onClick={createChat}
      disabled={creating}
      aria-busy={creating || undefined}
    >
      <Plus className="size-4" />
      {creating ? <Trans>Creating chat…</Trans> : <Trans>New chat</Trans>}
    </Button>
  );
}
function HomeState({
  title,
  caption,
  action,
  role,
  error,
}: {
  title: string;
  caption: string;
  action: React.ReactNode;
  role?: "alert";
  error?: React.ReactNode;
}) {
  return (
    <div className="app-scroll">
      <div
        className="project-screen-column min-h-full items-center justify-center text-center"
        role={role}
      >
        <h1 className="text-headline-section">{title}</h1>
        <p className="mt-2 text-compact text-muted-foreground">{caption}</p>
        <div className="mt-5">{action}</div>
        {error ? <div className="mt-3">{error}</div> : null}
      </div>
    </div>
  );
}
function HomeLoading() {
  return (
    <div className="app-scroll" role="status" aria-busy="true">
      <span className="sr-only">
        <Trans>Loading chats</Trans>
      </span>
      <div className="project-screen-column gap-8" aria-hidden>
        <section className="flex flex-col gap-3">
          <Skeleton className="h-7 w-28 motion-reduce:animate-none" />
          <Skeleton className="h-44 rounded-lg motion-reduce:animate-none" />
        </section>
        <section className="flex flex-col gap-3">
          <Skeleton className="h-7 w-36 motion-reduce:animate-none" />
          <div className="grid grid-cols-1 gap-4 @2xl/project-home:grid-cols-2">
            {[0, 1, 2, 3].map((x) => (
              <Skeleton key={x} className="h-40 rounded-lg motion-reduce:animate-none" />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
