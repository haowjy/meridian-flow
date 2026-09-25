/** Shared project chat row with accessible open and independent state controls. */
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { Star } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ThreadUserStateCommandView } from "@/client/query/thread-user-state-commands";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { WorkIdentity } from "@/components/app/WorkIdentity";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatProjectChatActivity } from "./project-chat-activity-date";

export type ProjectChatRowProps = {
  item: ProjectChatItem;
  now: number;
  onOpen: (item: ProjectChatItem) => void;
  onFavorite: (item: ProjectChatItem, value: boolean) => void;
  favorite: ThreadUserStateCommandView;
  /** Opens the list's delete confirmation; omitted where a list cannot delete. */
  onDelete?: (item: ProjectChatItem) => void;
  onActiveChange?: (id: string, active: boolean) => void;
};

/** Loading anatomy kept with the real row so their three lanes cannot drift. */
export function ProjectChatRowSkeleton() {
  return (
    <li data-project-chat-row-layout className="project-chat-row-layout grid px-2 py-1.5">
      <Skeleton className="col-start-1 row-start-1 mr-2 h-4 motion-reduce:animate-none" />
      <div data-project-chat-row-work className="px-1">
        <Skeleton className="h-4 w-full motion-reduce:animate-none" />
      </div>
      <Skeleton className="col-start-1 row-start-2 mt-1 h-3 motion-reduce:animate-none" />
      <div className="col-start-3 row-span-2 row-start-1 grid place-items-center [@media(hover:none)]:min-h-11 [@media(pointer:coarse)]:min-h-11">
        <Skeleton className="h-3 w-12 motion-reduce:animate-none" />
      </div>
    </li>
  );
}

export function ProjectChatRow({
  item,
  now,
  onOpen,
  onFavorite,
  favorite,
  onDelete,
  onActiveChange,
}: ProjectChatRowProps) {
  const { i18n } = useLingui();
  const [menuOpen, setMenuOpen] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const instanceId = useId();
  const title = item.title || t`New chat`;
  const actionRequiredId = item.actionRequired ? `${instanceId}-action-required` : undefined;
  const favoriteValue = !item.isFavorite;
  const favoriteSuppressed = favorite.pending;
  const retryFavoriteValue = favorite.retryValue;
  const activity = formatProjectChatActivity(item.lastActivityAt, now, i18n.locale);
  const fullActivity = new Intl.DateTimeFormat(i18n.locale, {
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date(item.lastActivityAt));
  const agentName = item.agentName ?? "General";
  const agentLabel = t`Agent: ${agentName}`;
  const active = menuOpen || focusWithin;
  useEffect(() => {
    onActiveChange?.(item.id, active);
    return () => onActiveChange?.(item.id, false);
  }, [active, item.id, onActiveChange]);

  return (
    <div
      data-project-chat-row={item.id}
      // The shared inset list-row recipe: rounded hover paint inside the gutter,
      // the same ground as the chat switcher's rows.
      className="group relative min-w-0 rounded-md px-2 py-1.5 transition-colors motion-reduce:transition-none hover:bg-dropdown-hover"
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false);
      }}
    >
      <button
        type="button"
        aria-label={t`Open ${title}`}
        aria-describedby={actionRequiredId}
        onClick={() => onOpen(item)}
        className="focus-ring absolute inset-0 z-0 rounded-md text-left"
      >
        <span className="sr-only">{title}</span>
      </button>
      {actionRequiredId ? (
        <span id={actionRequiredId} className="sr-only">
          {t`The AI asked you a question`}
        </span>
      ) : null}
      <div
        data-project-chat-row-layout
        className="project-chat-row-layout pointer-events-none relative z-10 grid min-w-0 text-sm"
      >
        <span
          data-project-chat-row-line
          className={cn(
            "col-start-1 row-start-1 min-w-0 truncate",
            item.actionRequired ? "font-semibold" : "font-medium",
          )}
        >
          {title}
        </span>
        {/* The flat list has no Favorites section, so a favorite keeps a standing
            star beside its Agent; other rows offer the outline on hover, like the
            actions menu. */}
        <div data-project-chat-row-work className="text-xs font-medium text-foreground">
          <IconButton
            size="sm"
            aria-pressed={item.isFavorite}
            aria-label={
              item.isFavorite ? t`Remove ${title} from favorites` : t`Add ${title} to favorites`
            }
            aria-disabled={favoriteSuppressed || undefined}
            onClick={() => {
              if (!favoriteSuppressed) onFavorite(item, favoriteValue);
            }}
            className={cn(
              // Touch gets a 44px target without widening the Agent lane: the
              // hit area extends past the 32px button instead of growing it.
              "pointer-events-auto relative [@media(hover:none)]:after:absolute [@media(hover:none)]:after:-inset-1.5 [@media(hover:none)]:after:content-[''] [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1.5 [@media(pointer:coarse)]:after:content-['']",
              item.isFavorite
                ? "text-primary hover:text-primary"
                : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100",
            )}
          >
            <Star aria-hidden className={cn("size-4", item.isFavorite && "fill-current")} />
          </IconButton>
          <WorkIdentity
            data-project-chat-row-agent
            className="px-1"
            name={item.agentName}
            unavailableLabel="General"
            aria-label={agentLabel}
            title={agentName}
          />
        </div>
        <div
          data-project-chat-row-line
          className="col-start-1 row-start-2 flex min-w-0 items-center gap-2 text-compact text-muted-foreground"
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
          data-project-chat-row-trailing
          className="pointer-events-none col-start-3 row-span-2 row-start-1 grid place-items-center"
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
            <OverflowMenu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              label={t`Actions for ${title}`}
              triggerClassName="[@media(hover:none)]:size-11 [@media(pointer:coarse)]:size-11"
              triggerProps={{
                "data-project-chat-row-actions": item.id,
                "aria-busy": favorite.pending || undefined,
              }}
            >
              <DropdownMenuItem
                aria-disabled={favoriteSuppressed || undefined}
                onSelect={() => {
                  if (!favoriteSuppressed) onFavorite(item, favoriteValue);
                }}
              >
                <span>{item.isFavorite ? t`Remove from favorites` : t`Add to favorites`}</span>
              </DropdownMenuItem>
              {onDelete ? (
                <DropdownMenuItem variant="destructive" onSelect={() => onDelete(item)}>
                  <span>{t`Delete chat`}</span>
                </DropdownMenuItem>
              ) : null}
            </OverflowMenu>
          </div>
        </div>
      </div>
      {favorite.error ? (
        <div className="relative z-10">
          <InlineErrorRow
            message={t`Favorite wasn’t saved`}
            onRetry={
              retryFavoriteValue === undefined
                ? undefined
                : () => onFavorite(item, retryFavoriteValue)
            }
          />
        </div>
      ) : null}
    </div>
  );
}
