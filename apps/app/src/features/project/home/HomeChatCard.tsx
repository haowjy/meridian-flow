/** One accessible Home chat card, including its independent state controls. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { HomeChatItem } from "@meridian/contracts/protocol";
import { MoreHorizontal, Star } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { formatHomeActivity } from "./home-activity-date";

export type HomeChatCardProps = {
  item: HomeChatItem;
  variant?: "continue" | "regular";
  now: number;
  onOpen: (item: HomeChatItem) => void;
  onFavorite: (item: HomeChatItem, value: boolean, keyboard: boolean) => void;
  onUnread: (item: HomeChatItem, value: boolean) => Promise<boolean>;
  getCommandState: (
    id: string,
    field: "isFavorite" | "isUnread",
  ) => { pending: boolean; error: Error | null };
};
export function HomeChatCard({
  item,
  variant = "regular",
  now,
  onOpen,
  onFavorite,
  onUnread,
  getCommandState,
}: HomeChatCardProps) {
  const title = item.title || t`New chat`;
  const attentionId = item.attention !== "none" ? `home-attention-${item.id}` : undefined;
  const favorite = getCommandState(item.id, "isFavorite");
  const unread = getCommandState(item.id, "isUnread");
  return (
    <article
      data-home-card={item.id}
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
          {item.attention === "actionRequired"
            ? t`The AI asked you a question`
            : t`New reply since you last opened`}
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
      <div className="absolute right-3 top-3 z-20 flex gap-1">
        <IconButton
          data-home-favorite={item.id}
          className="[@media(pointer:coarse)]:size-11"
          aria-pressed={item.isFavorite}
          aria-disabled={favorite.pending || undefined}
          aria-busy={favorite.pending || undefined}
          aria-label={
            item.isFavorite ? t`Remove ${title} from favorites` : t`Add ${title} to favorites`
          }
          onClick={(event) => {
            if (!favorite.pending) onFavorite(item, !item.isFavorite, event.detail === 0);
          }}
        >
          <Star className={cn("size-4", item.isFavorite && "fill-current text-cinnabar")} />
        </IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              className="[@media(pointer:coarse)]:size-11"
              aria-label={t`Actions for ${title}`}
              aria-disabled={unread.pending || undefined}
            >
              <MoreHorizontal className="size-4" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              aria-disabled={unread.pending || undefined}
              onSelect={() => {
                if (!unread.pending) void onUnread(item, item.attention === "none");
              }}
            >
              <span>{item.attention === "none" ? t`Mark unread` : t`Mark read`}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {unread.error ? (
        <div
          role="alert"
          className="absolute bottom-2 right-3 z-20 flex items-center gap-1 rounded-md bg-background px-2 py-1 text-meta text-destructive shadow-card"
        >
          <Trans>Read status wasn’t saved.</Trans>
          <button
            type="button"
            className="focus-ring rounded-sm font-semibold underline underline-offset-2"
            onClick={() => void onUnread(item, item.attention === "none")}
          >
            <Trans>Retry</Trans>
          </button>
        </div>
      ) : null}
    </article>
  );
}
