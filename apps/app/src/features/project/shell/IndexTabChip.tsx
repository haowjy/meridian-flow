/**
 * IndexTabChip — an icon-only door to a destination's index (All chats, All
 * Work) in the pane band, right after the sidebar toggle. Active when the
 * index is the page below (the page rises into it); otherwise an inactive tab.
 */
import type { LucideIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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
          className={cn(
            "focus-ring relative flex shrink-0 items-center px-3 [--tab-chip-surface:var(--color-background)]",
            active
              ? "tab-chip-active text-foreground"
              : "tab-chip-inactive text-muted-foreground hover:text-foreground",
          )}
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
