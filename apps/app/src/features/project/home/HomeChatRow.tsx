/** One accessible, borderless Home chat row with independent state controls. */
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import type { HomeChatItem } from "@meridian/contracts/protocol";
import { MoreHorizontal } from "lucide-react";
import { useRef, useState } from "react";
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
  const { i18n } = useLingui();
  const [menuOpen, setMenuOpen] = useState(false);
  const title = item.title || t`New chat`;
  const attentionId = item.attention !== "none" ? `home-attention-${item.id}` : undefined;
  const readErrorId = `home-read-error-${item.id}`;
  const favorite = getCommandState(item.id, "isFavorite");
  const unread = getCommandState(item.id, "isUnread");
  const favoriteValue = !item.isFavorite;
  const unreadValue = item.attention === "none";
  const favoriteSuppressed = favorite.pending;
  const unreadSuppressed = unread.pending && unread.desiredValue === unreadValue;
  const activity = formatHomeActivity(item.lastActivityAt, now, i18n.locale);
  const fullActivity = new Intl.DateTimeFormat(i18n.locale, {
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date(item.lastActivityAt));
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

      <div
        data-home-row-layout
        className="home-row-layout pointer-events-none relative z-10 grid min-w-0 text-sm"
      >
        <span
          data-home-row-line
          className={cn(
            "col-span-2 col-start-1 row-start-1 min-w-0 truncate pr-2",
            item.attention !== "none" ? "font-semibold" : "font-medium",
          )}
        >
          {title}
        </span>
        <span
          data-home-row-work
          className="col-start-3 row-start-1 min-w-0 truncate px-2 text-center text-xs text-muted-foreground"
          title={item.work?.title}
        >
          {workLabel}
        </span>
        <div
          data-home-row-line
          className="col-span-4 col-start-1 row-start-2 flex min-w-0 items-center gap-2 text-compact text-muted-foreground"
        >
          <p className="min-w-0 max-w-[65ch] truncate">
            {item.lastMessagePreview ?? t`No messages yet.`}
          </p>
          <time
            className="hidden shrink-0 whitespace-nowrap text-xs tabular-nums [@media(hover:none)]:inline [@media(pointer:coarse)]:inline"
            dateTime={item.lastActivityAt}
            title={fullActivity}
          >
            {activity === "now" ? t`now` : activity}
          </time>
        </div>

        <div
          data-home-row-trailing
          className="pointer-events-none col-start-5 row-span-2 row-start-1 grid place-items-center"
        >
          <time
            className={cn(
              "col-start-1 row-start-1 max-w-full truncate text-center text-xs text-muted-foreground tabular-nums group-hover:invisible group-focus-within:invisible [@media(hover:none)]:hidden [@media(pointer:coarse)]:hidden",
              menuOpen && "invisible",
            )}
            dateTime={item.lastActivityAt}
            title={fullActivity}
          >
            {activity === "now" ? t`now` : activity}
          </time>

          <div
            className={cn(
              "pointer-events-none col-start-1 row-start-1 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:opacity-100",
              menuOpen && "pointer-events-auto opacity-100",
            )}
          >
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <IconButton
                  data-home-row-actions={item.id}
                  className={cn(
                    "[@media(hover:none)]:size-11 [@media(pointer:coarse)]:size-11",
                    unread.error && "text-destructive",
                  )}
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
      </div>
    </div>
  );
}
