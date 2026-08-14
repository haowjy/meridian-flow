/** Chat-first project Home: one container-responsive, server-projected conversation feed. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { HomeChatItem } from "@meridian/contracts/protocol";
import { MoreHorizontal, Plus, Star } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useHomeChatFeed } from "@/client/query/useHomeChatFeed";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useCreateChat } from "../chat/use-create-chat";

export type HomeScreenProps = { projectId: string; onSelectThread: (threadId: string) => void };

export function formatHomeActivity(value: string, now: number, locale?: string): string {
  const date = new Date(value);
  const elapsed = Math.max(0, now - date.getTime());
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d`;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}

export function HomeScreen({ projectId, onSelectThread }: HomeScreenProps) {
  const feed = useHomeChatFeed(projectId);
  const creation = useCreateChat(projectId, onSelectThread);
  const sentinel = useRef<HTMLDivElement>(null);
  const [movement, setMovement] = useState<{
    threadId: string;
    scrollTop: number;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");
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
  useLayoutEffect(() => {
    if (!movement) return;
    const control = document.querySelector<HTMLButtonElement>(
      `[data-home-favorite="${CSS.escape(movement.threadId)}"]`,
    );
    const scrollport = control?.closest<HTMLElement>(".app-scroll");
    if (scrollport) scrollport.scrollTop = movement.scrollTop;
    control?.focus({ preventScroll: true });
    setMovement(null);
  }, [feed.grouped, movement]);

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
    onFavorite: (item: HomeChatItem, value: boolean) => {
      const scrollTop = document.querySelector<HTMLElement>(".app-scroll")?.scrollTop ?? 0;
      setMovement({
        threadId: item.id,
        scrollTop,
      });
      setAnnouncement(
        value ? t`${item.title} moved to Favorite chats` : t`${item.title} moved to Recent chats`,
      );
      feed.setFavorite(item.id, value);
    },
    onUnread: feed.setUnread,
  };
  return (
    <div className="app-scroll">
      <div className="project-screen-column gap-8">
        <h1 className="sr-only">
          <Trans>Home</Trans>
        </h1>
        <span className="sr-only" aria-live="polite">
          {announcement}
        </span>
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
          <FeedSection title={t`Favorite chats`} items={favorites} cardProps={cardProps} />
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

function FeedSection({
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

type HomeChatCardProps = {
  item: HomeChatItem;
  variant?: "continue" | "regular";
  now: number;
  onOpen: (item: HomeChatItem) => void;
  onFavorite: (item: HomeChatItem, value: boolean) => void;
  onUnread: (id: string, value: boolean) => void;
};
export function HomeChatCard({
  item,
  variant = "regular",
  now,
  onOpen,
  onFavorite,
  onUnread,
}: HomeChatCardProps) {
  const title = item.title || t`New chat`;
  const attentionId = item.attention !== "none" ? `home-attention-${item.id}` : undefined;
  const attentionText =
    item.attention === "actionRequired"
      ? t`The AI asked you a question`
      : t`New reply since you last opened`;
  return (
    <article
      className={cn(
        "surface-card group relative overflow-hidden rounded-lg border border-border-subtle transition-[box-shadow,border-color] motion-reduce:transition-none hover:border-border",
        variant === "continue" ? "min-h-44 p-5 shadow-card" : "min-h-40 p-4 hover:shadow-card",
      )}
    >
      <button
        type="button"
        aria-label={t`Open ${title}`}
        aria-describedby={attentionId}
        onClick={() => onOpen(item)}
        className="focus-ring absolute inset-0 z-0 rounded-lg text-left"
      >
        <span className="sr-only">{title}</span>
      </button>
      {attentionId ? (
        <span id={attentionId} className="sr-only">
          {attentionText}
        </span>
      ) : null}
      <div className="pointer-events-none relative z-10 flex min-h-full flex-col pr-14 [@media(pointer:coarse)]:pr-24">
        <div className="flex min-w-0 items-center gap-2">
          {item.attention !== "none" ? (
            <span
              aria-hidden
              className={cn(
                "size-2 shrink-0 rounded-full",
                item.attention === "actionRequired" ? "bg-status-warning" : "bg-jade-text",
              )}
            />
          ) : null}
          <span
            className={cn(
              "truncate",
              variant === "continue" ? "text-body" : "text-sm",
              item.attention !== "none" ? "font-semibold" : "font-normal",
            )}
          >
            {title}
          </span>
        </div>
        <p
          className={cn(
            "mt-3 line-clamp-2 min-h-10 max-w-[65ch] text-muted-foreground",
            variant === "continue" ? "text-sm" : "text-compact",
          )}
        >
          {item.lastMessagePreview ?? t`No messages yet.`}
        </p>
        <div className="mt-auto flex min-w-0 items-center gap-3 pt-4 text-meta text-muted-foreground">
          <span className="min-w-0 flex-1 truncate" title={item.work?.title}>
            <Trans>Work: {item.work?.title ?? t`Work unavailable`}</Trans>
          </span>
          <time
            className="shrink-0 tabular-nums"
            dateTime={item.lastActivityAt}
            title={new Intl.DateTimeFormat(undefined, {
              dateStyle: "full",
              timeStyle: "short",
            }).format(new Date(item.lastActivityAt))}
          >
            {formatHomeActivity(item.lastActivityAt, now) === "now"
              ? t`now`
              : formatHomeActivity(item.lastActivityAt, now)}
          </time>
        </div>
      </div>
      <div className="absolute right-3 top-3 z-20 flex gap-1 [@media(pointer:coarse)]:gap-1">
        <IconButton
          data-home-favorite={item.id}
          className="[@media(pointer:coarse)]:size-11"
          aria-pressed={item.isFavorite}
          aria-label={
            item.isFavorite ? t`Remove ${title} from favorites` : t`Add ${title} to favorites`
          }
          onClick={() => onFavorite(item, !item.isFavorite)}
        >
          <Star className={cn("size-4", item.isFavorite && "fill-current text-cinnabar")} />
        </IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              className="[@media(pointer:coarse)]:size-11"
              aria-label={t`Actions for ${title}`}
            >
              <MoreHorizontal className="size-4" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onUnread(item.id, item.attention === "none")}>
              <span>{item.attention === "none" ? t`Mark unread` : t`Mark read`}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
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
