/** One accessible Home chat card, including its independent state controls. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { HomeChatItem } from "@meridian/contracts/protocol";
import { MoreHorizontal, Star } from "lucide-react";
import type { ThreadUserStateTransportState } from "@/client/query/thread-user-state-commands";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  ) => ThreadUserStateTransportState & { error: Error | null };
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
  const favoriteValue = !item.isFavorite;
  const unreadValue = item.attention === "none";
  const favoriteSuppressed = favorite.pending;
  const unreadSuppressed = unread.pending && unread.desiredValue === unreadValue;
  return (
    <Card
      role="article"
      data-home-card={item.id}
      className={cn(
        "group relative gap-0 overflow-hidden rounded-lg py-0 transition-[box-shadow,border-color] motion-reduce:transition-none hover:border-border",
        variant === "continue" ? "shadow-card" : "min-h-40 hover:shadow-card",
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
      <CardHeader
        className={cn(
          "pointer-events-none relative z-10 flex min-w-0 items-center gap-2 pb-0 pl-4 pr-14 pt-4 [@media(pointer:coarse)]:pr-24",
          variant === "continue" && "pl-5 pt-5",
        )}
      >
        {item.attention !== "none" ? (
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              item.attention === "actionRequired" ? "bg-status-warning" : "bg-jade-text",
            )}
          />
        ) : null}
        <CardTitle
          className={cn(
            "truncate leading-normal",
            variant === "continue" ? "text-body" : "text-sm",
            item.attention !== "none" ? "font-semibold" : "font-normal",
          )}
        >
          {title}
        </CardTitle>
        <CardAction className="pointer-events-auto absolute right-3 top-3 z-20 flex gap-1">
          <IconButton
            data-home-favorite={item.id}
            className="[@media(pointer:coarse)]:size-11"
            aria-pressed={item.isFavorite}
            aria-disabled={favoriteSuppressed || undefined}
            aria-busy={favorite.pending || undefined}
            aria-label={
              item.isFavorite ? t`Remove ${title} from favorites` : t`Add ${title} to favorites`
            }
            onClick={(event) => {
              if (!favoriteSuppressed) onFavorite(item, favoriteValue, event.detail === 0);
            }}
          >
            <Star className={cn("size-4", item.isFavorite && "fill-current text-cinnabar")} />
          </IconButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                className="[@media(pointer:coarse)]:size-11"
                aria-label={t`Actions for ${title}`}
                aria-disabled={unreadSuppressed || undefined}
                aria-busy={unread.pending || undefined}
              >
                <MoreHorizontal className="size-4" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                aria-disabled={unreadSuppressed || undefined}
                onSelect={() => {
                  if (!unreadSuppressed) void onUnread(item, unreadValue);
                }}
              >
                <span>{item.attention === "none" ? t`Mark unread` : t`Mark read`}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>
      <CardContent
        className={cn(
          "pointer-events-none relative z-10 mt-3 pl-4 pr-14 [@media(pointer:coarse)]:pr-24",
          variant === "continue" && "pl-5",
        )}
      >
        <p
          className={cn(
            "line-clamp-2 min-h-10 max-w-[65ch] text-muted-foreground",
            variant === "continue" ? "text-sm" : "text-compact",
          )}
        >
          {item.lastMessagePreview ?? t`No messages yet.`}
        </p>
      </CardContent>
      <CardFooter
        className={cn(
          "pointer-events-none relative z-10 flex min-w-0 items-center gap-3 pb-4 pl-4 pr-14 pt-4 text-meta text-muted-foreground [@media(pointer:coarse)]:pr-24",
          variant === "continue" ? "pb-5 pl-5 pt-3" : "mt-auto",
        )}
      >
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
      </CardFooter>
      {unread.error ? (
        <div
          role="alert"
          className="absolute bottom-2 right-3 z-20 flex items-center gap-1 rounded-md bg-background px-2 py-1 text-meta text-destructive shadow-card"
        >
          <Trans>Read status wasn’t saved.</Trans>
          <button
            type="button"
            className="focus-ring rounded-sm font-semibold underline underline-offset-2 [@media(pointer:coarse)]:min-h-11"
            onClick={() => void onUnread(item, item.attention === "none")}
          >
            <Trans>Retry</Trans>
          </button>
        </div>
      ) : null}
    </Card>
  );
}
