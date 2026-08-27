/** Shared project chat row with accessible open and independent state controls. */
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { useEffect, useId, useState } from "react";
import type { ThreadUserStateCommandView } from "@/client/query/thread-user-state-commands";
import { WorkIdentity } from "@/components/app/WorkIdentity";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { cn } from "@/lib/utils";
import { formatProjectChatActivity } from "./project-chat-activity-date";

export type ProjectChatRowProps = {
  item: ProjectChatItem;
  now: number;
  onOpen: (item: ProjectChatItem) => void;
  onFavorite: (item: ProjectChatItem, value: boolean) => void;
  favorite: ThreadUserStateCommandView;
  onActiveChange?: (id: string, active: boolean) => void;
};

export function ProjectChatRow({
  item,
  now,
  onOpen,
  onFavorite,
  favorite,
  onActiveChange,
}: ProjectChatRowProps) {
  const { i18n } = useLingui();
  const [menuOpen, setMenuOpen] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const instanceId = useId();
  const title = item.title || t`New chat`;
  const attentionId = item.attention !== "none" ? `${instanceId}-attention` : undefined;
  const favoriteValue = !item.isFavorite;
  const favoriteSuppressed = favorite.pending;
  const activity = formatProjectChatActivity(item.lastActivityAt, now, i18n.locale);
  const fullActivity = new Intl.DateTimeFormat(i18n.locale, {
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date(item.lastActivityAt));
  const workLabel = item.work?.title ? t`Work: ${item.work.title}` : t`Work unavailable`;
  const active = menuOpen || focusWithin;
  useEffect(() => {
    onActiveChange?.(item.id, active);
    return () => onActiveChange?.(item.id, false);
  }, [active, item.id, onActiveChange]);

  return (
    <div
      data-project-chat-row={item.id}
      className="group relative min-w-0 px-2 py-1.5 transition-colors motion-reduce:transition-none hover:bg-muted/40"
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false);
      }}
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
      <div
        data-project-chat-row-layout
        className="project-chat-row-layout pointer-events-none relative z-10 grid min-w-0 text-sm"
      >
        <span
          data-project-chat-row-line
          className={cn(
            "col-start-1 row-start-1 min-w-0 truncate",
            item.attention !== "none" ? "font-semibold" : "font-medium",
          )}
        >
          {title}
        </span>
        <WorkIdentity
          data-project-chat-row-work
          className="px-1"
          name={item.work?.title}
          unavailableLabel={t`Unavailable`}
          aria-label={workLabel}
          title={item.work?.title}
        />
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
            </OverflowMenu>
          </div>
        </div>
      </div>
    </div>
  );
}
