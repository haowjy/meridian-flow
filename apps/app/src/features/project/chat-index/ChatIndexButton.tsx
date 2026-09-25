/**
 * Header doors to the chat index. They sit in the pane's existing 40px band,
 * right after the sidebar toggle, where the Editor keeps its Recently opened
 * door, so they read as chrome rather than page content.
 *
 * - `ChatIndexChip` — the centered Chat pane, which rises out of the band like
 *   the document tab strip; it wears the same tab-chip grammar as History.
 * - `CurrentChatChip` — on the center index, the remembered chat as an
 *   inactive tab: the way back, like an open document tab beside Recents.
 *
 * The dock has no index: its switcher lists the chats.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { MessagesSquare } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function ChatIndexChip({ active, onClick }: { active: boolean; onClick?: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={t`All chats`}
          aria-current={active ? "page" : undefined}
          // Canvas surface for the active chip, as on the document tab strip.
          className={cn(
            "focus-ring relative flex shrink-0 items-center px-3 [--tab-chip-surface:var(--color-background)]",
            active
              ? "tab-chip-active text-foreground"
              : "tab-chip-inactive text-muted-foreground hover:text-foreground",
          )}
        >
          <MessagesSquare className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        <Trans>All chats</Trans>
      </TooltipContent>
    </Tooltip>
  );
}

export function CurrentChatChip({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t`Back to ${title}`}
      className="focus-ring tab-chip-inactive relative flex min-w-0 max-w-64 items-center self-stretch px-3 text-muted-foreground hover:text-foreground [--tab-chip-surface:var(--color-background)]"
    >
      <span className="truncate px-1 text-sm font-medium">{title}</span>
    </button>
  );
}
