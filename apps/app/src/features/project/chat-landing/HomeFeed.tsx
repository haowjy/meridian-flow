/** Complete Home feed presentation: sections, lists, pagination, and screen states. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { useEffect, useRef } from "react";
import type { HomeFeedNextPageIdentity } from "@/client/query/useHomeChatFeed";
import { useProjectChatUserState } from "@/client/query/useProjectChatUserState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ProjectChatRow,
  type ProjectChatRowProps,
  ProjectChatRowSkeleton,
} from "../chat-list/ProjectChatRow";

type FeedQuery = {
  isPending: boolean;
  isError: boolean;
  data: unknown;
  grouped: {
    continueChat: ProjectChatItem | null;
    favorites: ProjectChatItem[];
    recent: ProjectChatItem[];
  };
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  nextPageIdentity: HomeFeedNextPageIdentity | null;
  fetchNextPage: () => Promise<unknown>;
  refetch: () => Promise<unknown>;
};
export function HomeFeed({
  projectId,
  feed,
  rowProps,
}: {
  projectId: string;
  feed: FeedQuery;
  rowProps: Omit<ProjectChatRowProps, "item" | "favorite">;
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
      <div className="py-8 text-center" role="alert">
        <h2 className="text-headline-section">{t`Chats couldn’t load`}</h2>
        <p className="mt-2 text-compact text-muted-foreground">
          {t`Check your connection and try again.`}
        </p>
        <div className="mt-5">
          <Button
            variant="outline"
            className="[@media(pointer:coarse)]:min-h-11"
            onClick={() => void feed.refetch()}
          >
            <Trans>Retry</Trans>
          </Button>
        </div>
      </div>
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
        {continueChat ? (
          <ChatList projectId={projectId} items={[continueChat]} rowProps={rowProps} />
        ) : null}
      </section>
      {favorites.length ? (
        <Section projectId={projectId} title={t`Favorite`} items={favorites} rowProps={rowProps} />
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
                <HomeProjectChatRow projectId={projectId} item={item} rowProps={rowProps} />
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
  projectId,
  title,
  items,
  rowProps,
}: {
  projectId: string;
  title: string;
  items: ProjectChatItem[];
  rowProps: Omit<ProjectChatRowProps, "item" | "favorite">;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-headline-section">{title}</h2>
      <ChatList projectId={projectId} items={items} rowProps={rowProps} />
    </section>
  );
}
function ChatList({
  projectId,
  items,
  rowProps,
}: {
  projectId: string;
  items: ProjectChatItem[];
  rowProps: Omit<ProjectChatRowProps, "item" | "favorite">;
}) {
  return (
    <ul className="divide-y divide-border-subtle">
      {items.map((item) => (
        <li key={item.id}>
          <HomeProjectChatRow projectId={projectId} item={item} rowProps={rowProps} />
        </li>
      ))}
    </ul>
  );
}

function HomeProjectChatRow({
  projectId,
  item,
  rowProps,
}: {
  projectId: string;
  item: ProjectChatItem;
  rowProps: Omit<ProjectChatRowProps, "item" | "favorite">;
}) {
  const state = useProjectChatUserState(projectId, item);
  return <ProjectChatRow {...rowProps} {...state} />;
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
          <ul className="divide-y divide-border-subtle">
            <ProjectChatRowSkeleton />
          </ul>
        </section>
        <section className="flex flex-col gap-2">
          <Skeleton className="h-7 w-36 motion-reduce:animate-none" />
          <ul className="divide-y divide-border-subtle">
            {Array.from({ length: 4 }, (_, index) => (
              <ProjectChatRowSkeleton key={index} />
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
