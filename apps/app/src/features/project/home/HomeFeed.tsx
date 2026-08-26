/** Complete Home feed presentation: sections, lists, pagination, and screen states. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { HomeChatItem } from "@meridian/contracts/protocol";
import { useEffect, useRef } from "react";
import type { HomeFeedNextPageIdentity } from "@/client/query/useHomeChatFeed";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { HomeChatRow, type HomeChatRowProps } from "./HomeChatRow";

type FeedQuery = {
  isPending: boolean;
  isError: boolean;
  data: unknown;
  grouped: { continueChat: HomeChatItem | null; favorites: HomeChatItem[]; recent: HomeChatItem[] };
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  nextPageIdentity: HomeFeedNextPageIdentity | null;
  fetchNextPage: () => Promise<unknown>;
  refetch: () => Promise<unknown>;
};
export function HomeFeed({
  feed,
  rowProps,
}: {
  feed: FeedQuery;
  rowProps: Omit<HomeChatRowProps, "item">;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const requestedPage = useRef<HomeFeedNextPageIdentity | null>(null);
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

  if (feed.isPending) return <HomeLoading />;
  if (feed.isError && !feed.data)
    return (
      <HomeState
        role="alert"
        title={t`Chats couldn’t load`}
        caption={t`Check your connection and try again.`}
        action={
          <Button
            variant="outline"
            className="[@media(pointer:coarse)]:min-h-11"
            onClick={() => void feed.refetch()}
          >
            <Trans>Retry</Trans>
          </Button>
        }
      />
    );
  const { continueChat, favorites, recent } = feed.grouped;
  if (!continueChat && !favorites.length && !recent.length)
    return (
      <p className="py-8 text-center text-compact text-muted-foreground">
        <Trans>Your chats will appear here after you send a message.</Trans>
      </p>
    );

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-4">
          <h2 className="text-headline-section">
            <Trans>Continue</Trans>
          </h2>
        </div>
        {continueChat ? <ChatList items={[continueChat]} rowProps={rowProps} /> : null}
      </section>
      {favorites.length ? (
        <Section title={t`Favorite`} items={favorites} rowProps={rowProps} />
      ) : null}
      {recent.length || feed.hasNextPage ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-headline-section">
            <Trans>Recent chats</Trans>
          </h2>
          <ul
            className="divide-y divide-border-subtle"
            aria-busy={feed.isFetchingNextPage || undefined}
          >
            {recent.map((item) => (
              <li key={item.id}>
                <HomeChatRow item={item} {...rowProps} />
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
              className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
            >
              <Trans>More chats couldn’t load.</Trans>
              <Button
                variant="link"
                className="[@media(pointer:coarse)]:min-h-11"
                onClick={() => void feed.fetchNextPage()}
              >
                <Trans>Retry</Trans>
              </Button>
            </div>
          ) : (
            <div ref={sentinel} data-home-feed-sentinel aria-hidden className="h-px" />
          )}
        </section>
      ) : null}
    </div>
  );
}

function Section({
  title,
  items,
  rowProps,
}: {
  title: string;
  items: HomeChatItem[];
  rowProps: Omit<HomeChatRowProps, "item">;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-headline-section">{title}</h2>
      <ChatList items={items} rowProps={rowProps} />
    </section>
  );
}
function ChatList({
  items,
  rowProps,
}: {
  items: HomeChatItem[];
  rowProps: Omit<HomeChatRowProps, "item">;
}) {
  return (
    <ul className="divide-y divide-border-subtle">
      {items.map((item) => (
        <li key={item.id}>
          <HomeChatRow item={item} {...rowProps} />
        </li>
      ))}
    </ul>
  );
}
function HomeState({
  title,
  caption,
  action,
  role,
}: {
  title: string;
  caption: string;
  action?: React.ReactNode;
  role?: "alert";
}) {
  return (
    <div className="py-8 text-center" role={role}>
      <h2 className="text-headline-section">{title}</h2>
      <p className="mt-2 text-compact text-muted-foreground">{caption}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
function HomeLoading() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-busy="true">
      <span className="sr-only">
        <Trans>Loading chats</Trans>
      </span>
      <div aria-hidden className="contents">
        <section className="flex flex-col gap-2">
          <Skeleton className="h-7 w-28 motion-reduce:animate-none" />
          <SkeletonRows count={1} />
        </section>
        <section className="flex flex-col gap-2">
          <Skeleton className="h-7 w-36 motion-reduce:animate-none" />
          <SkeletonRows count={4} />
        </section>
      </div>
    </div>
  );
}
function SkeletonRows({ count }: { count: number }) {
  return (
    <ul className="divide-y divide-border-subtle">
      {Array.from({ length: count }, (_, x) => (
        <li key={x} data-home-row-layout className="home-row-layout grid px-2 py-1.5">
          <Skeleton className="col-span-2 col-start-1 row-start-1 mr-2 h-4 motion-reduce:animate-none" />
          <Skeleton
            data-home-row-work
            className="col-start-3 row-start-1 mx-2 h-4 motion-reduce:animate-none"
          />
          <Skeleton className="col-span-4 col-start-1 row-start-2 mt-1 h-3 motion-reduce:animate-none" />
          <div className="col-start-5 row-span-2 row-start-1 grid place-items-center [@media(hover:none)]:min-h-11 [@media(pointer:coarse)]:min-h-11">
            <Skeleton className="h-3 w-12 motion-reduce:animate-none" />
          </div>
        </li>
      ))}
    </ul>
  );
}
