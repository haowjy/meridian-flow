/** Complete Home feed presentation: sections, grids, pagination, and screen states. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { HomeChatItem } from "@meridian/contracts/protocol";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { HomeChatCard, type HomeChatCardProps } from "./HomeChatCard";

type FeedQuery = {
  isPending: boolean;
  isError: boolean;
  data: unknown;
  grouped: { continueChat: HomeChatItem | null; favorites: HomeChatItem[]; recent: HomeChatItem[] };
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => Promise<unknown>;
  refetch: () => Promise<unknown>;
};
export function HomeFeed({
  feed,
  cardProps,
  newChat,
  newChatError,
}: {
  feed: FeedQuery;
  cardProps: Omit<HomeChatCardProps, "item" | "variant">;
  newChat: React.ReactNode;
  newChatError?: React.ReactNode;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
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
  if (!continueChat && !favorites.length && !recent.length)
    return (
      <HomeState
        title={t`Start a chat`}
        caption={t`Your conversations will appear here.`}
        action={newChat}
        error={newChatError}
      />
    );

  return (
    <div className="project-screen-column gap-8">
      <h1 className="sr-only">
        <Trans>Home</Trans>
      </h1>
      <section className="flex flex-col gap-3">
        <div className="flex min-h-9 items-center justify-between gap-4">
          <h2 className="text-headline-section">
            <Trans>Continue</Trans>
          </h2>
          {newChat}
        </div>
        {newChatError}
        {continueChat ? (
          <HomeChatCard item={continueChat} variant="continue" {...cardProps} />
        ) : null}
      </section>
      {favorites.length ? (
        <Section title={t`Favorite chats`} items={favorites} cardProps={cardProps} />
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
  );
}

function Section({
  title,
  items,
  cardProps,
}: {
  title: string;
  items: HomeChatItem[];
  cardProps: Omit<HomeChatCardProps, "item" | "variant">;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-headline-section">{title}</h2>
      <ul className="grid grid-cols-1 gap-4 @2xl/project-home:grid-cols-2">
        {items.map((item) => (
          <li key={item.id}>
            <HomeChatCard item={item} {...cardProps} />
          </li>
        ))}
      </ul>
    </section>
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
    <div
      className="project-screen-column min-h-full items-center justify-center text-center"
      role={role}
    >
      <h1 className="text-headline-section">{title}</h1>
      <p className="mt-2 text-compact text-muted-foreground">{caption}</p>
      <div className="mt-5">{action}</div>
      {error ? <div className="mt-3">{error}</div> : null}
    </div>
  );
}
function HomeLoading() {
  return (
    <div className="project-screen-column gap-8" role="status" aria-busy="true">
      <span className="sr-only">
        <Trans>Loading chats</Trans>
      </span>
      <div aria-hidden className="contents">
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
