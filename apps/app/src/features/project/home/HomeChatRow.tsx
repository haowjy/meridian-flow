/** One accessible, borderless Home chat row with independent state controls. */
import { t } from "@lingui/core/macro";
import type { HomeChatItem } from "@meridian/contracts/protocol";
import { MoreHorizontal } from "lucide-react";
import { useRef } from "react";
import type { ThreadUserStateTransportState } from "@/client/query/thread-user-state-commands";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { formatHomeActivity } from "./home-activity-date";

export type HomeChatRowProps = {
  item: HomeChatItem;
  now: number;
  onOpen: (item: HomeChatItem) => void;
  onFavorite: (item: HomeChatItem, value: boolean, keyboard: boolean) => void;
  onUnread: (item: HomeChatItem, value: boolean) => Promise<boolean>;
  getCommandState: (
    id: string,
    field: "isFavorite" | "isUnread",
  ) => ThreadUserStateTransportState & { error: Error | null };
};

export function HomeChatRow({
  item,
  now,
  onOpen,
  onFavorite,
  onUnread,
  getCommandState,
}: HomeChatRowProps) {
  const title = item.title || t`New chat`;
  const attentionId = item.attention !== "none" ? `home-attention-${item.id}` : undefined;
  const readErrorId = `home-read-error-${item.id}`;
  const favorite = getCommandState(item.id, "isFavorite");
  const unread = getCommandState(item.id, "isUnread");
  const favoriteValue = !item.isFavorite;
  const unreadValue = item.attention === "none";
  const favoriteSuppressed = favorite.pending;
  const unreadSuppressed = unread.pending && unread.desiredValue === unreadValue;
  const activity = formatHomeActivity(item.lastActivityAt, now);
  const workLabel = item.work?.title ? t`Work: ${item.work.title}` : t`Work unavailable`;
  const favoritePointer = useRef(false);

  return (
    <div
      data-home-row={item.id}
      className="group relative min-w-0 px-2 py-1.5 transition-colors motion-reduce:transition-none hover:bg-muted/40"
    >
      <button
        type="button"
        aria-label={t`Open ${title}`}
        aria-describedby={attentionId}
        onClick={() => onOpen(item)}
        className="focus-ring absolute inset-0 z-0 text-left"
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
      {unread.error ? (
        <span id={readErrorId} className="sr-only">
          {t`Read status wasn’t saved. Open actions to retry.`}
        </span>
      ) : null}

      <div className="pointer-events-none relative z-10 flex min-w-0 items-center gap-2 pr-8 text-sm [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:pr-12">
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
            "min-w-0 flex-[3] truncate",
            item.attention !== "none" ? "font-semibold" : "font-medium",
          )}
        >
          {title}
        </span>
        <span
          className="min-w-0 max-w-[40%] flex-1 truncate text-compact text-muted-foreground"
          title={item.work?.title}
        >
          {workLabel}
        </span>
      </div>

      <div className="pointer-events-none relative z-10 min-w-0 pr-16 text-compact text-muted-foreground [@media(hover:none)]:pr-12 [@media(pointer:coarse)]:pr-12">
        <div className="inline-flex max-w-full min-w-0 items-center gap-2">
          <p className="min-w-0 max-w-[65ch] truncate">
            {item.lastMessagePreview ?? t`No messages yet.`}
          </p>
          <time
            className="hidden shrink-0 whitespace-nowrap tabular-nums [@media(hover:none)]:inline [@media(pointer:coarse)]:inline"
            dateTime={item.lastActivityAt}
            title={new Intl.DateTimeFormat(undefined, {
              dateStyle: "full",
              timeStyle: "short",
            }).format(new Date(item.lastActivityAt))}
          >
            {activity === "now" ? t`now` : activity}
          </time>
        </div>
      </div>

      <time
        className="pointer-events-none absolute bottom-1.5 right-2 z-10 w-14 truncate text-right text-compact text-muted-foreground tabular-nums transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 motion-reduce:transition-none [@media(hover:none)]:hidden [@media(pointer:coarse)]:hidden"
        dateTime={item.lastActivityAt}
        title={new Intl.DateTimeFormat(undefined, {
          dateStyle: "full",
          timeStyle: "short",
        }).format(new Date(item.lastActivityAt))}
      >
        {activity === "now" ? t`now` : activity}
      </time>

      <div className="absolute right-2 top-1/2 z-20 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              data-home-favorite={item.id}
              className={cn("[@media(pointer:coarse)]:size-11", unread.error && "text-destructive")}
              aria-label={t`Actions for ${title}`}
              aria-describedby={unread.error ? readErrorId : undefined}
              aria-invalid={unread.error ? true : undefined}
              aria-busy={favorite.pending || unread.pending || undefined}
            >
              <MoreHorizontal className="size-4" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              aria-disabled={favoriteSuppressed || undefined}
              onPointerDown={() => {
                favoritePointer.current = true;
              }}
              onKeyDown={() => {
                favoritePointer.current = false;
              }}
              onSelect={() => {
                if (!favoriteSuppressed) {
                  onFavorite(item, favoriteValue, !favoritePointer.current);
                }
                favoritePointer.current = false;
              }}
            >
              <span>{item.isFavorite ? t`Remove from favorites` : t`Add to favorites`}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              aria-disabled={unreadSuppressed || undefined}
              onSelect={() => {
                if (!unreadSuppressed) void onUnread(item, unreadValue);
              }}
            >
              <span>
                {unread.error
                  ? item.attention === "none"
                    ? t`Retry mark unread`
                    : t`Retry mark read`
                  : item.attention === "none"
                    ? t`Mark unread`
                    : t`Mark read`}
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
