/**
 * Pane-band doors between a destination's index and its current item.
 *
 * - `IndexTabChip` — an icon-only door to the index (All chats, All Work),
 *   right after the sidebar toggle. Active when the index is the page below
 *   (the page rises into it); otherwise an inactive tab.
 * - `ReturnTabChip` — on the index, the remembered item (the current chat, the
 *   last opened Work) as an inactive tab: the way back, like an open document
 *   tab beside Recents.
 */
import { t } from "@lingui/core/macro";
import type { LucideIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { tabChipClass } from "./tab-chip";

export function IndexTabChip({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className={cn("focus-ring shrink-0", tabChipClass(active))}
        >
          <Icon className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function ReturnTabChip({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t`Back to ${title}`}
      className={cn("focus-ring min-w-0 max-w-64", tabChipClass(false))}
    >
      <span className="truncate px-1 text-sm font-medium">{title}</span>
    </button>
  );
}
